(async function () {
  const statusText = document.getElementById('statusText');
  const statusDot = document.getElementById('statusDot');
  const retryBtn = document.getElementById('retryBtn');
  const video = document.getElementById('video');
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const SERVER_ORIGIN = 'http://127.0.0.1:8787';
  const WS_ORIGIN = 'ws://127.0.0.1:8787';

  let ws = null;
  let stream = null;

  function setStatus(text, live) {
    statusText.textContent = text;
    statusDot.classList.toggle('live', !!live);
  }

  async function getToken() {
    const res = await fetch(`${SERVER_ORIGIN}/token`);
    if (!res.ok) throw new Error('Servidor local não respondeu. Ele está rodando (npm start na pasta server)?');
    const data = await res.json();
    return data.token;
  }

  // Chrome/Brave/Edge (Chromium) têm chrome.desktopCapture, que pede o
  // streamId antes de chamar getUserMedia. Firefox não tem essa API — usa
  // getDisplayMedia direto, que é o padrão web para captura de tela.
  function requestDisplayStream() {
    if (typeof chrome !== 'undefined' && chrome.desktopCapture) {
      return new Promise((resolve, reject) => {
        chrome.desktopCapture.chooseDesktopMedia(['screen'], async (streamId) => {
          if (!streamId) {
            reject(new Error('Compartilhamento cancelado.'));
            return;
          }
          try {
            const s = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: {
                mandatory: {
                  chromeMediaSource: 'desktop',
                  chromeMediaSourceId: streamId
                }
              }
            });
            resolve(s);
          } catch (err) {
            reject(err);
          }
        });
      });
    }

    return navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor' },
      audio: false
    });
  }

  async function startCapture() {
    try {
      stream = await requestDisplayStream();
      video.srcObject = stream;
      await video.play();
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        setStatus('Compartilhamento encerrado.', false);
        retryBtn.classList.remove('hidden');
        if (ws) ws.close();
      });
      retryBtn.classList.add('hidden');
      connectWS();
    } catch (err) {
      setStatus(err.message === 'Compartilhamento cancelado.' ? err.message : 'Erro ao capturar: ' + err.message, false);
      retryBtn.classList.remove('hidden');
    }
  }

  // Modelos de visão fatiam a imagem em "tokens" proporcionais à resolução:
  // imagem maior = mais tokens = análise muito mais lenta (medido: 1920px leva
  // ~3x o tempo de 1280px só para processar a imagem). A Página B escolhe.
  const DEFAULT_MAX_DIM = 1600;
  const THUMB_DIM = 320;
  const MEMORY_DIM = 1024;

  function drawScaled(maxDim, mimeType, quality) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(mimeType, quality);
  }

  function grabFrame(maxDim) {
    // A imagem cheia vai só para o Ollama/endpoint de cópia; a miniatura é o
    // que trafega de imediato até a Página B para exibir apenas 48px.
    return {
      // PNG preserva letras pequenas e linhas finas da tela, que perdiam
      // nitidez com a compressão JPEG antes de chegar ao modelo de visão.
      image: drawScaled(maxDim || DEFAULT_MAX_DIM, 'image/png'),
      // Versão intermediária para reaproveitar nas próximas análises sem
      // estourar a janela de contexto com vários PNGs grandes.
      memory: drawScaled(MEMORY_DIM, 'image/jpeg', 0.9),
      thumb: drawScaled(THUMB_DIM, 'image/jpeg', 0.65)
    };
  }

  async function connectWS() {
    let token;
    try {
      token = await getToken();
    } catch (err) {
      setStatus(err.message, false);
      setTimeout(connectWS, 3000);
      return;
    }

    ws = new WebSocket(`${WS_ORIGIN}/ws?role=source&token=${encodeURIComponent(token)}`);

    ws.addEventListener('open', () => setStatus('Compartilhando tela — pronto para captura', true));

    ws.addEventListener('close', () => {
      if (!stream || !stream.active) return; // capture itself was stopped, don't loop
      setStatus('Desconectado do servidor local. Reconectando…', false);
      setTimeout(connectWS, 2000);
    });

    ws.addEventListener('error', () => ws.close());

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'grab') {
        const { image, memory, thumb } = grabFrame(msg.maxDim);
        ws.send(JSON.stringify({ type: 'frame', id: msg.id, image, memory, thumb }));
      }
    });
  }

  setStatus('Selecione "Tela inteira" na janela do navegador…', false);
  startCapture();
  retryBtn.addEventListener('click', startCapture);
})();
