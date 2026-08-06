(function () {
  const params = new URLSearchParams(location.search);
  let token = params.get('token') || localStorage.getItem('token');
  if (params.get('token')) {
    localStorage.setItem('token', params.get('token'));
    history.replaceState({}, '', location.pathname);
  }
  if (!token) {
    document.body.innerHTML =
      '<p style="padding:2rem;font-family:sans-serif">Token ausente. Abra o link mostrado no console do servidor (npm start).</p>';
    return;
  }

  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const modelSelect = document.getElementById('modelSelect');
  const qualitySelect = document.getElementById('qualitySelect');
  const refreshModels = document.getElementById('refreshModels');
  const promptInput = document.getElementById('promptInput');
  const captureBtn = document.getElementById('captureBtn');
  const stopBtn = document.getElementById('stopBtn');
  const stack = document.getElementById('stack');
  const clearAll = document.getElementById('clearAll');
  const lastPreview = document.getElementById('lastPreview');
  const lastPreviewImg = document.getElementById('lastPreviewImg');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  let sourceConnected = false;
  const cards = new Map(); // id -> card element
  let activeId = null; // id do card que está "Analisando…" agora — é o que o botão Parar afeta

  function updateStopButton() {
    stopBtn.disabled = !activeId;
  }

  // Só um newline vira <br> como as pessoas esperam de um chat, não a regra
  // rígida do Markdown puro (que exige duas quebras de linha).
  marked.setOptions({ breaks: true, gfm: true });

  // O texto vem de uma IA — sanitiza antes de jogar como innerHTML (a imagem
  // capturada pode conter texto malicioso que o modelo transcreve de volta).
  function renderMarkdown(rawText) {
    const html = marked.parse(rawText || '');
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  }

  function highlightCode(container) {
    container.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  }

  // Reparsear markdown inteiro a cada token chegaria a dezenas de vezes por
  // segundo; agrupa tudo que chega no mesmo frame num único render.
  function scheduleRender(card) {
    if (card._renderPending) return;
    card._renderPending = true;
    requestAnimationFrame(() => {
      card._renderPending = false;
      renderCardNow(card);
    });
  }

  function renderCardNow(card) {
    const respEl = card.querySelector('.response');
    respEl.innerHTML = renderMarkdown(card._rawText);
    highlightCode(respEl);
  }

  function connectWS() {
    ws = new WebSocket(`${wsProto}://${location.host}/ws?role=viewer&token=${encodeURIComponent(token)}`);
    ws.addEventListener('open', () => setConn(true));
    ws.addEventListener('close', () => {
      setConn(false);
      setTimeout(connectWS, 2000);
    });
    ws.addEventListener('error', () => ws.close());
    ws.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
  }

  function setConn(open) {
    statusText.textContent = open
      ? sourceConnected
        ? 'Página A conectada'
        : 'Aguardando Página A…'
      : 'sem conexão com o servidor';
    statusDot.classList.toggle('live', open && sourceConnected);
  }

  function handleMessage(msg) {
    if (msg.type === 'source-status') {
      sourceConnected = msg.connected;
      setConn(ws.readyState === WebSocket.OPEN);
    } else if (msg.type === 'preview') {
      onPreview(msg.id, msg.image);
    } else if (msg.type === 'queued') {
      onQueued(msg.id, msg.position, msg.total);
    } else if (msg.type === 'analyzing') {
      onAnalyzing(msg.id);
    } else if (msg.type === 'retry') {
      onRetry(msg.id, msg.nextAttempt, msg.maxAttempts, msg.delayMs);
    } else if (msg.type === 'token') {
      onToken(msg.id, msg.text);
    } else if (msg.type === 'done') {
      onDone(msg.id, msg.timing);
    } else if (msg.type === 'error') {
      onError(msg.id, msg.message);
    } else if (msg.type === 'stopped') {
      onStopped(msg.id);
    }
  }

  async function loadModels() {
    modelSelect.innerHTML = '<option>carregando…</option>';
    try {
      const res = await fetch(`/api/models?token=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'erro');
      const models = data.models || [];
      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">nenhum modelo encontrado</option>';
        return;
      }
      models.sort((a, b) => Number(b.isVision) - Number(a.isVision) || a.name.localeCompare(b.name));
      modelSelect.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.isVision ? `${m.name} (visão)` : m.name;
        modelSelect.appendChild(opt);
      }
    } catch (err) {
      modelSelect.innerHTML = '<option value="">erro ao carregar modelos</option>';
    }
  }

  function newCard(id) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-top">
        <img class="thumb" />
        <div class="meta">
          <div class="model"></div>
          <div class="time"></div>
        </div>
        <button class="del" title="apagar">🗑</button>
      </div>
      <div class="prompt"></div>
      <div class="card-status"></div>
      <div class="response"></div>
    `;
    card.querySelector('.del').addEventListener('click', () => {
      card.remove();
      cards.delete(id);
      // Avisa o servidor: se ainda estava na fila, tira de lá; se era o que
      // estava rodando agora, aborta e deixa a fila seguir pro próximo.
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel', id }));
      }
      if (id === activeId) { activeId = null; updateStopButton(); }
    });
    card.querySelector('.thumb').addEventListener('click', () => openLightbox(id, card.querySelector('.thumb').src));
    card._rawText = '';
    stack.prepend(card);
    return card;
  }

  function onPreview(id, image) {
    const card = newCard(id);
    card.querySelector('.thumb').src = image;
    card.querySelector('.model').textContent = modelSelect.value;
    card.querySelector('.time').textContent = new Date().toLocaleTimeString();
    card.querySelector('.prompt').textContent = promptInput.value || '(sem prompt)';
    card.querySelector('.card-status').textContent = 'Capturado — entrando na fila…';
    cards.set(id, card);
    lastPreviewImg.src = image;
    lastPreview.classList.remove('hidden');
  }

  function onQueued(id, position, total) {
    const card = cards.get(id);
    if (!card) return;
    card.querySelector('.card-status').textContent =
      position === 1 ? 'Próxima da fila…' : `Na fila (${position}/${total})`;
  }

  function onAnalyzing(id) {
    activeId = id;
    updateStopButton();
    const card = cards.get(id);
    if (!card) return;
    card.querySelector('.card-status').textContent = 'Analisando…';
  }

  function onRetry(id, nextAttempt, maxAttempts, delayMs) {
    const card = cards.get(id);
    if (!card) return;
    const espera = delayMs ? ` em ${Math.round(delayMs / 1000)}s` : '';
    card.querySelector('.card-status').textContent =
      `Servidor recusou (sobrecarga) — tentando de novo${espera} (${nextAttempt}/${maxAttempts})…`;
  }

  function onToken(id, text) {
    const card = cards.get(id);
    if (!card) return;
    const statusEl = card.querySelector('.card-status');
    if (statusEl.textContent) statusEl.textContent = '';
    card._rawText += text;
    scheduleRender(card);
  }

  function onDone(id, timing) {
    if (id === activeId) { activeId = null; updateStopButton(); }
    const card = cards.get(id);
    if (!card) return;
    // Render final e imediato (não agendado) — garante que o texto completo
    // apareça formatado mesmo que o último frame agendado ainda não tenha rodado.
    renderCardNow(card);
    const statusEl = card.querySelector('.card-status');
    if (!timing) {
      statusEl.textContent = '';
      return;
    }
    const parts = [`${(timing.totalMs / 1000).toFixed(1)}s`];
    if (timing.imageMs) parts.push(`imagem ${(timing.imageMs / 1000).toFixed(1)}s`);
    if (timing.tokensPerSec) parts.push(`${timing.tokensPerSec} tok/s`);
    statusEl.textContent = parts.join(' · ');
    statusEl.classList.add('timing');
  }

  function onError(id, message) {
    if (id === activeId) { activeId = null; updateStopButton(); }
    const card = cards.get(id);
    if (card) {
      card.querySelector('.card-status').textContent = '';
      card.querySelector('.response').textContent = '⚠ ' + message;
    } else {
      alert(message);
    }
  }

  // Servidor confirmando que abortou a análise (botão Parar, ou o card foi
  // apagado enquanto estava rodando). Mantém o que já tinha sido gerado.
  function onStopped(id) {
    if (id === activeId) { activeId = null; updateStopButton(); }
    const card = cards.get(id);
    if (!card) return;
    renderCardNow(card);
    card.querySelector('.card-status').textContent = '⏹ Interrompido';
  }

  // Mostra a miniatura na hora e troca pela imagem cheia quando ela chega —
  // assim abrir a captura é instantâneo mesmo no celular.
  function openLightbox(id, thumbSrc) {
    lightboxImg.src = thumbSrc;
    lightbox.classList.remove('hidden');
    const full = new Image();
    full.onload = () => {
      if (!lightbox.classList.contains('hidden')) lightboxImg.src = full.src;
    };
    full.src = `/api/image/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
  }
  lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));

  captureBtn.addEventListener('click', () => {
    if (!sourceConnected) {
      alert('Página A não está conectada. Abra a extensão no PC e compartilhe a tela.');
      return;
    }
    if (!modelSelect.value) {
      alert('Selecione um modelo.');
      return;
    }
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    ws.send(JSON.stringify({
      type: 'capture',
      id,
      prompt: promptInput.value,
      model: modelSelect.value,
      maxDim: Number(qualitySelect.value)
    }));
  });

  clearAll.addEventListener('click', () => {
    if (stack.children.length === 0) return;
    if (confirm('Apagar todas as respostas?')) {
      stack.innerHTML = '';
      cards.clear();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel-all' }));
      }
      activeId = null;
      updateStopButton();
    }
  });

  stopBtn.addEventListener('click', () => {
    if (!activeId) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cancel', id: activeId }));
    }
  });

  refreshModels.addEventListener('click', loadModels);

  // Deixa o modelo já carregado na RAM antes da primeira captura.
  function preload() {
    if (!modelSelect.value) return;
    fetch(`/api/preload?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelSelect.value })
    }).catch(() => {});
  }
  modelSelect.addEventListener('change', preload);

  loadModels().then(preload);
  connectWS();
})();
