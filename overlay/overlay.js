(function () {
  const SERVER_ORIGIN = 'http://127.0.0.1:8787';
  const WS_ORIGIN = 'ws://127.0.0.1:8787';

  const statusDot = document.getElementById('statusDot');
  const statusEl = document.getElementById('status');
  const responseEl = document.getElementById('response');
  const thumbEl = document.getElementById('thumb');
  const closeBtn = document.getElementById('closeBtn');
  const contentEl = document.querySelector('.content');

  closeBtn.addEventListener('click', () => window.overlayAPI.close());

  window.overlayAPI.onScrollDown(() => {
    contentEl.scrollBy({ top: 90, behavior: 'smooth' });
  });

  marked.setOptions({ breaks: true, gfm: true });

  // O texto vem de uma IA — sanitiza antes de jogar como innerHTML (a imagem
  // capturada pode conter texto malicioso que o modelo transcreva de volta).
  function renderMarkdown(rawText) {
    const html = marked.parse(rawText || '');
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  }

  function highlightCode() {
    responseEl.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  }

  let rawText = '';
  let renderPending = false;

  // Reparsear a cada token chegaria dezenas de vezes por segundo; agrupa
  // tudo que chega no mesmo frame num único render (igual à Página B).
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      renderNow();
    });
  }

  function renderNow() {
    responseEl.innerHTML = renderMarkdown(rawText);
    highlightCode();
  }

  let ws = null;
  let currentId = null; // ignora eventos de uma captura antiga se uma nova já começou

  async function getToken() {
    const res = await fetch(`${SERVER_ORIGIN}/token`);
    if (!res.ok) throw new Error('Servidor local não respondeu.');
    return (await res.json()).token;
  }

  async function connect() {
    let token;
    try {
      token = await getToken();
    } catch {
      statusEl.textContent = 'Servidor não está rodando…';
      setTimeout(connect, 3000);
      return;
    }

    ws = new WebSocket(`${WS_ORIGIN}/ws?role=overlay&token=${encodeURIComponent(token)}`);

    ws.addEventListener('open', () => statusDot.classList.add('live'));

    ws.addEventListener('close', () => {
      statusDot.classList.remove('live');
      setTimeout(connect, 2000);
    });

    ws.addEventListener('error', () => ws.close());

    ws.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
  }

  function handleMessage(msg) {
    if (msg.type === 'source-status') return;

    if (msg.type === 'preview') {
      currentId = msg.id;
      rawText = '';
      responseEl.innerHTML = '';
      thumbEl.src = msg.image;
      thumbEl.classList.remove('hidden');
      statusEl.textContent = 'Capturado — entrando na fila…';
      return;
    }

    // Tudo daqui pra baixo só importa se for sobre a captura mais recente —
    // sem isso, uma resposta atrasada de uma captura anterior sobrescreveria
    // o card por cima de uma mais nova.
    if (msg.id !== currentId) return;

    if (msg.type === 'queued') {
      statusEl.textContent = msg.position === 1 ? 'Próxima da fila…' : `Na fila (${msg.position}/${msg.total})`;
    } else if (msg.type === 'analyzing') {
      statusEl.textContent = 'Analisando…';
    } else if (msg.type === 'retry') {
      statusEl.textContent = `Erro passageiro — tentando de novo (${msg.nextAttempt}/${msg.maxAttempts})…`;
    } else if (msg.type === 'token') {
      statusEl.textContent = '';
      rawText += msg.text;
      scheduleRender();
    } else if (msg.type === 'done') {
      statusEl.textContent = '';
      renderNow();
    } else if (msg.type === 'stopped') {
      statusEl.textContent = '⏹ Interrompido';
      renderNow();
    } else if (msg.type === 'error') {
      statusEl.textContent = '';
      responseEl.textContent = '⚠ ' + msg.message;
    }
  }

  connect();
})();
