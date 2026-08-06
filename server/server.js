const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { parse } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8787;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 120_000;
const OLLAMA_MAX_RETRIES = Number(process.env.OLLAMA_MAX_RETRIES) || 2;
// Os erros 500 dos modelos :cloud são rejeição por capacidade (voltam em
// ~800ms, não são falha de processamento). Medido: 5 requisições em rajada
// falham 2x, espaçadas de 15s falham 0x. Por isso o backoff é exponencial e
// começa alto — insistir rápido só toma outra rejeição.
const OLLAMA_RETRY_DELAY_MS = Number(process.env.OLLAMA_RETRY_DELAY_MS) || 3000;
// Uma captura de tela vira facilmente 1000+ tokens de imagem; contexto menor
// que isso trunca a imagem e piora a resposta. 4096 cobre imagem + resposta
// sem gastar RAM à toa (relevante numa máquina de 8 GB).
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 4096;
// Teto de resposta: sem isso um modelo OCR pode gerar 2000 tokens (medido) e
// levar minutos. Generoso o bastante para não cortar respostas normais.
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT) || 512;
// Não force threads: o Ollama detecta os núcleos físicos, e forçar o número
// de núcleos lógicos (hyperthreading) costuma deixar a inferência mais lenta.
const OLLAMA_NUM_THREAD = Number(process.env.OLLAMA_NUM_THREAD) || undefined;
const TOKEN_FILE = path.join(__dirname, '.token');

function loadOrCreateToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  }
  const token = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  return token;
}

const TOKEN = loadOrCreateToken();

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireToken(req, res, next) {
  const token = req.query.token || req.headers['x-auth-token'];
  if (token !== TOKEN) return res.status(401).json({ error: 'token inválido' });
  next();
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Só quem já está rodando no próprio PC (a extensão) pode buscar o token.
// Evita que qualquer um na mesma rede Wi-Fi descubra o token só de achar a porta.
app.get('/token', (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: 'somente local' });
  res.json({ token: TOKEN });
});

app.get('/api/models', requireToken, async (req, res) => {
  try {
    const tagsRes = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!tagsRes.ok) throw new Error('ollama /api/tags falhou');
    const { models = [] } = await tagsRes.json();

    const enriched = await Promise.all(models.map(async (m) => {
      let isVision = /llava|bakllava|moondream|vision|minicpm-v|qwen.?[.-]?vl|pixtral|granite.*vision/i.test(m.name);
      try {
        const showRes = await fetch(`${OLLAMA_URL}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: m.name })
        });
        if (showRes.ok) {
          const info = await showRes.json();
          if (Array.isArray(info.capabilities)) {
            isVision = info.capabilities.includes('vision');
          } else if (info.details && Array.isArray(info.details.families)) {
            isVision = isVision || info.details.families.includes('clip');
          }
        }
      } catch {
        // mantém o palpite por nome se /api/show falhar
      }
      return { name: m.name, size: m.size, isVision };
    }));

    res.json({ models: enriched });
  } catch (err) {
    res.status(502).json({
      error: 'Não foi possível falar com o Ollama. Ele está rodando (ollama serve)?',
      detail: String(err)
    });
  }
});

// Carregar um modelo na RAM leva vários segundos numa máquina sem GPU.
// Fazer isso quando o usuário escolhe o modelo tira esse custo da primeira
// captura, que é justamente quando ele está esperando a resposta.
app.post('/api/preload', requireToken, async (req, res) => {
  const { model } = req.body || {};
  if (!model) return res.status(400).json({ error: 'model obrigatório' });
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: '30m' })
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// A Página B só recebe miniaturas; a imagem cheia vem por aqui quando o
// usuário realmente abre a captura.
app.get('/api/image/:id', requireToken, (req, res) => {
  const image = fullImages.get(req.params.id);
  if (!image) return res.status(404).json({ error: 'imagem não disponível' });
  const [, mime, b64] = image.match(/^data:(image\/\w+);base64,(.*)$/) || [];
  if (!b64) return res.status(500).json({ error: 'formato inesperado' });
  res.set('Content-Type', mime).set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(b64, 'base64'));
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let sourceSocket = null;
const viewers = new Set();
const pendingCaptures = new Map(); // id -> { viewerSocket }

function safeSend(sock, payload) {
  if (sock.readyState === sock.OPEN) sock.send(payload);
}

function broadcastSourceStatus() {
  const payload = JSON.stringify({ type: 'source-status', connected: !!sourceSocket });
  for (const v of viewers) safeSend(v, payload);
}

wss.on('connection', (sock, req) => {
  const { query } = parse(req.url, true);
  if (query.token !== TOKEN) {
    sock.close(4001, 'unauthorized');
    return;
  }

  if (query.role === 'source') {
    sourceSocket = sock;
    broadcastSourceStatus();
    sock.on('close', () => {
      if (sourceSocket === sock) sourceSocket = null;
      broadcastSourceStatus();
    });
    sock.on('message', (raw) => handleSourceMessage(raw));
    return;
  }

  viewers.add(sock);
  safeSend(sock, JSON.stringify({ type: 'source-status', connected: !!sourceSocket }));
  sock.on('close', () => viewers.delete(sock));
  sock.on('message', (raw) => handleViewerMessage(sock, raw));
});

function handleSourceMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type === 'frame') {
    const pending = pendingCaptures.get(msg.id);
    if (!pending) return;
    pendingCaptures.delete(msg.id);
    enqueueAnalysis(pending.viewerSocket, msg.id, msg.image, msg.thumb, pending.prompt, pending.model);
  }
}

function handleViewerMessage(viewerSocket, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type === 'capture') {
    if (!sourceSocket) {
      safeSend(viewerSocket, JSON.stringify({ type: 'error', id: msg.id, message: 'Página A não está conectada.' }));
      return;
    }
    pendingCaptures.set(msg.id, { viewerSocket, prompt: msg.prompt, model: msg.model });
    safeSend(sourceSocket, JSON.stringify({ type: 'grab', id: msg.id, maxDim: msg.maxDim }));
    return;
  }

  if (msg.type === 'cancel') {
    cancelJob(msg.id);
    return;
  }

  if (msg.type === 'cancel-all') {
    cancelAll();
    return;
  }
}

// O Ollama processa uma inferência de visão por vez de forma eficiente;
// então empilhamos os pedidos aqui e processamos um de cada vez, avisando
// a fila para o cliente em vez de deixar tudo bater junto no Ollama.
const analysisQueue = [];
let queueBusy = false;
// O job que está sendo processado agora (fora da fila). Guardamos aqui para
// o botão de parar / apagar conseguir abortar algo que já saiu da fila e
// está com uma requisição HTTP aberta no Ollama.
let currentJob = null;

// Cancela um job específico, esteja ele só esperando na fila ou já sendo
// processado. É o que torna "apagar" e "parar" efetivos de verdade — antes
// disso, apagar um card só escondia ele, mas o servidor continuava
// processando e contando ele na fila (por isso a numeração ficava errada).
function cancelJob(id) {
  const idx = analysisQueue.findIndex((j) => j.id === id);
  if (idx !== -1) {
    analysisQueue.splice(idx, 1);
    broadcastQueuePositions();
    return;
  }
  if (currentJob && currentJob.id === id) {
    currentJob.cancelledByUser = true;
    if (currentJob.controller) currentJob.controller.abort();
  }
}

function cancelAll() {
  analysisQueue.length = 0;
  if (currentJob) {
    currentJob.cancelledByUser = true;
    if (currentJob.controller) currentJob.controller.abort();
  }
}

// Imagens em resolução cheia, buscadas sob demanda quando o usuário toca na
// miniatura. Limitado para a memória não crescer sem fim numa sessão longa.
const fullImages = new Map();
const MAX_STORED_IMAGES = 30;

function rememberFullImage(id, image) {
  fullImages.set(id, image);
  while (fullImages.size > MAX_STORED_IMAGES) {
    fullImages.delete(fullImages.keys().next().value);
  }
}

function enqueueAnalysis(viewerSocket, id, image, thumb, prompt, model) {
  // Só a miniatura viaja até a Página B; a imagem cheia fica aqui no servidor
  // e vai direto para o Ollama (evita mandar ~140 KB ao celular por captura).
  safeSend(viewerSocket, JSON.stringify({ type: 'preview', id, image: thumb || image }));
  rememberFullImage(id, image);
  analysisQueue.push({ viewerSocket, id, image, prompt, model });
  broadcastQueuePositions();
  processQueue();
}

function broadcastQueuePositions() {
  analysisQueue.forEach((job, i) => {
    safeSend(job.viewerSocket, JSON.stringify({ type: 'queued', id: job.id, position: i + 1, total: analysisQueue.length }));
  });
}

async function processQueue() {
  if (queueBusy) return;
  const job = analysisQueue.shift();
  if (!job) return;
  queueBusy = true;
  broadcastQueuePositions();
  safeSend(job.viewerSocket, JSON.stringify({ type: 'analyzing', id: job.id }));
  currentJob = { id: job.id, cancelledByUser: false, controller: null };
  await runAnalysis(job.viewerSocket, job.id, job.image, job.prompt, job.model, currentJob);
  currentJob = null;
  queueBusy = false;
  processQueue();
}

async function runAnalysis(viewerSocket, id, image, prompt, model, jobState) {
  const base64 = image.replace(/^data:image\/\w+;base64,/, '');
  const maxAttempts = OLLAMA_MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (jobState.cancelledByUser) {
      safeSend(viewerSocket, JSON.stringify({ type: 'stopped', id }));
      return;
    }

    // Sem isso, uma resposta do Ollama que trava (ex: backend :cloud engasgado)
    // prende a fila inteira para sempre, sem avisar ninguém.
    const controller = new AbortController();
    jobState.controller = controller;
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    let streamedAnything = false;

    try {
      const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          prompt: prompt || 'Descreva o que você vê nesta imagem.',
          images: [base64],
          stream: true,
          // Mantém o modelo carregado na memória entre capturas — evita o
          // atraso de recarregar o modelo do zero a cada análise.
          keep_alive: '30m',
          options: {
            // Cada captura é independente: sem contexto grande para processar,
            // e teto de resposta para o modelo não divagar por minutos.
            num_ctx: OLLAMA_NUM_CTX,
            num_predict: OLLAMA_NUM_PREDICT,
            ...(OLLAMA_NUM_THREAD ? { num_thread: OLLAMA_NUM_THREAD } : {})
          }
        })
      });

      if (!ollamaRes.ok || !ollamaRes.body) {
        throw new Error(`Ollama respondeu ${ollamaRes.status}`);
      }

      const reader = ollamaRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      const startedAt = Date.now();
      let firstTokenAt = null;
      let stats = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk = JSON.parse(line);
          if (chunk.response) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            streamedAnything = true;
            full += chunk.response;
            safeSend(viewerSocket, JSON.stringify({ type: 'token', id, text: chunk.response }));
          }
          if (chunk.done) {
            stats = {
              // Tempo gasto "olhando" a imagem — costuma dominar tudo em CPU.
              imageMs: chunk.prompt_eval_duration ? Math.round(chunk.prompt_eval_duration / 1e6) : null,
              tokens: chunk.eval_count || null
            };
          }
          if (chunk.error) throw new Error(chunk.error);
        }
      }

      const totalMs = Date.now() - startedAt;
      const genMs = firstTokenAt ? Date.now() - firstTokenAt : 0;
      safeSend(viewerSocket, JSON.stringify({
        type: 'done',
        id,
        fullText: full,
        model,
        prompt,
        timing: {
          totalMs,
          waitMs: firstTokenAt ? firstTokenAt - startedAt : totalMs,
          tokensPerSec: stats && stats.tokens && genMs > 0 ? +(stats.tokens / (genMs / 1000)).toFixed(1) : null,
          imageMs: stats ? stats.imageMs : null
        }
      }));
      return;
    } catch (err) {
      // abort() dispara o mesmo AbortError tanto por timeout quanto por
      // cancelamento manual (botão parar / apagar) — o flag é o que distingue.
      if (jobState.cancelledByUser) {
        clearTimeout(timeoutId);
        safeSend(viewerSocket, JSON.stringify({ type: 'stopped', id }));
        return;
      }

      const isTimeout = err.name === 'AbortError';

      // Só tenta de novo automaticamente em falhas rápidas (ex: 500 passageiro)
      // e antes de qualquer texto ter sido enviado. Um travamento que já
      // esperou o timeout inteiro não deve ser repetido — só deixa o usuário
      // esperando ainda mais por algo que provavelmente vai travar de novo.
      const canRetry = !isTimeout && !streamedAnything && attempt < maxAttempts;

      const retryDelay = OLLAMA_RETRY_DELAY_MS * Math.pow(2, attempt - 1);

      if (canRetry) {
        safeSend(viewerSocket, JSON.stringify({
          type: 'retry',
          id,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs: retryDelay,
          message: `Erro do Ollama (${err.message}) — tentando de novo…`
        }));
        clearTimeout(timeoutId);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        if (jobState.cancelledByUser) {
          safeSend(viewerSocket, JSON.stringify({ type: 'stopped', id }));
          return;
        }
        continue;
      }

      const message = isTimeout
        ? `O Ollama não respondeu em ${OLLAMA_TIMEOUT_MS / 1000}s — pulando para a próxima.`
        : 'Falha ao consultar o Ollama: ' + err.message;
      safeSend(viewerSocket, JSON.stringify({ type: 'error', id, message }));
      return;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lanIPs = [];
  for (const iface of Object.values(nets)) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) lanIPs.push(addr.address);
    }
  }

  console.log('\nServidor rodando na porta ' + PORT);
  console.log(`  Local (PC):  http://127.0.0.1:${PORT}/?token=${TOKEN}`);
  for (const ip of lanIPs) {
    console.log(`  Celular:     http://${ip}:${PORT}/?token=${TOKEN}`);
  }
  console.log('\nAbra o link do celular no navegador do celular (mesma rede Wi-Fi).');
  console.log('Token salvo em .token — apague o arquivo para gerar um novo.\n');
});
