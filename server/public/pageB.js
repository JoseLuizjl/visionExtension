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
  const memoryCount = document.getElementById('memoryCount');
  const clearMemory = document.getElementById('clearMemory');
  const lastPreview = document.getElementById('lastPreview');
  const lastPreviewImg = document.getElementById('lastPreviewImg');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const toast = document.getElementById('toast');

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  let sourceConnected = false;
  const cards = new Map(); // id -> card element
  let activeId = null; // id do card que está "Analisando…" agora — é o que o botão Parar afeta
  let toastTimer = null;

  function updateStopButton() {
    stopBtn.disabled = !activeId;
  }

  function updateMemoryStatus(count) {
    const total = Number(count) || 0;
    memoryCount.textContent = `Memória ativa · ${total} ${total === 1 ? 'análise' : 'análises'}`;
    clearMemory.disabled = total === 0;
  }

  // Só um newline vira <br> como as pessoas esperam de um chat, não a regra
  // rígida do Markdown puro (que exige duas quebras de linha).
  marked.setOptions({ breaks: true, gfm: true });
  // Modelos costumam responder fórmulas em LaTeX ($...$ e $$...$$) — sem
  // isso elas aparecem como texto cru com barras invertidas soltas.
  // nonStandard: a regra padrão só reconhece o fechamento de "$...$" antes de
  // espaço/pontuação específica — "$-5$)" (comum em intervalos matemáticos)
  // ficava sem converter porque ")" não está nessa lista.
  marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

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
    } else if (msg.type === 'memory-status') {
      updateMemoryStatus(msg.count);
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
        <img class="thumb" alt="Captura — toque para copiar" role="button" tabindex="0"
          title="Toque para copiar a imagem" />
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
    const thumb = card.querySelector('.thumb');
    thumb.addEventListener('click', () => copyCaptureImage(id, thumb.src, thumb));
    thumb.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      copyCaptureImage(id, thumb.src, thumb);
    });
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
    lastPreviewImg.dataset.captureId = id;
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

  function showToast(message, isError) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('error', !!isError);
    toast.classList.remove('hidden');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
  }

  function fullImageUrl(id) {
    return `/api/image/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
  }

  // A escrita de imagens no clipboard aceita PNG de forma consistente. A
  // captura enviada à IA pode ter outro formato, então normalizamos antes de
  // copiar sem reduzir suas dimensões.
  async function toPng(blob) {
    if (blob.type === 'image/png') return blob;

    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();

    return new Promise((resolve, reject) => {
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error('Não foi possível converter a imagem.')), 'image/png');
    });
  }

  async function copyCaptureImage(id, thumbSrc, trigger) {
    if (!id || trigger.classList.contains('copying')) return;
    trigger.classList.add('copying');
    showToast('Copiando imagem…');

    try {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        throw new Error('clipboard indisponível');
      }
      // O write começa ainda dentro do gesto de toque. Passar uma Promise ao
      // ClipboardItem evita que Safari/Chrome percam a autorização enquanto a
      // imagem completa é baixada e convertida.
      const png = fetch(fullImageUrl(id)).then(async (res) => {
        if (!res.ok) throw new Error('imagem não disponível');
        return toPng(await res.blob());
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      showToast('Imagem copiada ✓');
    } catch (err) {
      // Navegadores móveis bloqueiam a API de clipboard em páginas HTTP da
      // rede local. Nesse caso abrimos a imagem cheia: pressionar e segurar
      // oferece a ação "Copiar imagem" do próprio navegador.
      openLightbox(id, thumbSrc);
      showToast('Pressione e segure a imagem para copiar', true);
    } finally {
      trigger.classList.remove('copying');
    }
  }

  // Mostra a miniatura na hora e troca pela imagem cheia quando ela chega.
  function openLightbox(id, thumbSrc) {
    lightboxImg.src = thumbSrc;
    lightbox.classList.remove('hidden');
    const full = new Image();
    full.onload = () => {
      if (!lightbox.classList.contains('hidden')) lightboxImg.src = full.src;
    };
    full.src = fullImageUrl(id);
  }
  lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));

  lastPreviewImg.addEventListener('click', () => {
    copyCaptureImage(lastPreviewImg.dataset.captureId, lastPreviewImg.src, lastPreviewImg);
  });
  lastPreviewImg.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    copyCaptureImage(lastPreviewImg.dataset.captureId, lastPreviewImg.src, lastPreviewImg);
  });

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
    if (confirm('Apagar os cards? A memória da IA será mantida.')) {
      stack.innerHTML = '';
      cards.clear();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel-all' }));
      }
      activeId = null;
      updateStopButton();
    }
  });

  clearMemory.addEventListener('click', async () => {
    if (!confirm('Esquecer definitivamente todas as análises anteriores? Isso não pode ser desfeito.')) return;
    clearMemory.disabled = true;
    try {
      const res = await fetch(`/api/memory?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('falha ao apagar');
      updateMemoryStatus(0);
      showToast('Memória apagada');
    } catch {
      clearMemory.disabled = false;
      showToast('Não foi possível apagar a memória', true);
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
