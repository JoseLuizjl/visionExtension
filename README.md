# Screen → Ollama Vision

Três peças que trabalham juntas:

- **`extension/`** — extensão Chrome/Brave/Edge (Chromium, Manifest V3). É a **Página A**: captura a tela inteira do PC e mantém o stream vivo numa aba.
- **`extension-firefox/`** — mesma coisa, empacotada para Firefox (a API de captura de tela é diferente lá).
- **`server/`** — servidor Node local. Serve a **Página B** (acessível também pelo celular na mesma Wi-Fi), faz a ponte via WebSocket entre A e B, e chama o Ollama local para analisar os frames.

## Limitação importante (não é bug)

Chrome, Brave, Edge e Firefox sempre mostram um indicador nativo de "compartilhando tela" quando a captura está ativa — isso é imposto pelo navegador (em todos eles) e não dá pra suprimir via extensão. A Página A não tenta esconder isso de outros sites; a discrição aqui é só na interface (sem popups/banners chamativos), não na detecção do navegador.

## Pré-requisitos

- Node.js 18+ (você tem v24, ok)
- Ollama instalado e rodando (`ollama serve`, ou o app do Ollama aberto)
- Um modelo com visão. Modelos `:cloud` funcionam mas são lentos e imprevisíveis (ver seção de performance). Para tempo previsível, use um modelo **local** — e nesta máquina (7,7 GB de RAM, sem GPU) ele precisa ser pequeno:
  ```
  ollama pull moondream     # ~1,7 GB, o mais rápido
  ollama pull glm-ocr       # ~2,2 GB, bom para ler texto da tela
  ```
  Evite `llava` (7B, ~4,7 GB) e qualquer `llama3.2-vision` (11B) aqui: com 7,7 GB de RAM total o sistema vai paginar para o disco e ficar inutilizável.

## 1. Subir o servidor

```
cd server
npm install
npm start
```

Ele imprime algo como:

```
Local (PC):  http://127.0.0.1:8787/?token=XXXX
Celular:     http://192.168.x.x:8787/?token=XXXX
```

O `.token` é gerado uma vez e salvo em `server/.token`. Sem ele, ninguém na sua rede consegue ver os modelos, os frames ou as respostas — apague o arquivo se quiser gerar um novo.

Se o Windows Firewall perguntar, permita o Node.js em redes privadas (senão o celular não alcança o servidor).

## 2. Instalar a extensão (Página A)

### Brave / Chrome / Edge

1. Abra `brave://extensions` (ou `chrome://extensions`, `edge://extensions`)
2. Ative "Modo do desenvolvedor"
3. "Carregar sem compactação" → selecione a pasta `extension/`
4. Clique no ícone da extensão → escolha **"Tela inteira"** no seletor nativo do navegador

Fica instalada normalmente, sobrevive a reiniciar o navegador.

### Firefox

1. Abra `about:debugging#/runtime/this-firefox`
2. "Carregar extensão temporária…" → selecione o arquivo `extension-firefox/manifest.json` (o arquivo, não a pasta)
3. Clique no ícone da extensão → no seletor de compartilhamento do Firefox, escolha a tela inteira (não uma janela/aba)

Diferença importante: no Firefox, extensão carregada assim é **temporária** — ela some quando o Firefox reinicia, e você precisa repetir o passo 2. Não tem um jeito simples de deixar permanente sem assinar a extensão pela Mozilla.

Nos dois casos, a aba que abrir (Página A) precisa ficar aberta (pode minimizar/deixar em outra janela) — é ela que segura o stream da tela.

## 3. Abrir a Página B

- No PC: `http://127.0.0.1:8787/?token=XXXX` (o link exato aparece no terminal do servidor)
- No celular: o link "Celular" impresso no terminal, no navegador do celular, **na mesma rede Wi-Fi** do PC

Na Página B: escolha o modelo (os com visão aparecem marcados "(visão)"), escreva o prompt, toque em **📸 Capturar**. A resposta entra no topo da pilha, com miniatura da captura, e dá pra apagar uma por uma ou tudo de uma vez.

Dá pra tocar em **Capturar** várias vezes seguidas sem esperar a anterior terminar — cada captura entra numa fila (mostrada no card: "Na fila (2/3)" → "Analisando…") e é processada uma de cada vez, na ordem. Se uma captura demorar demais (padrão: 120s sem resposta do Ollama), ela dá erro sozinha e a fila segue pra próxima em vez de travar tudo. Pra mudar esse limite: `OLLAMA_TIMEOUT_MS=60000 npm start`.

**Parar e apagar cancelam de verdade** — o botão **⏹ Parar** interrompe a análise que está rodando agora (mantém o texto já gerado até ali) e a fila passa pra próxima automaticamente. Apagar (🗑) um card individual também cancela o trabalho dele no servidor, esteja ele rodando ou só esperando na fila; "Apagar tudo" cancela tudo de uma vez. Antes disso, apagar um card só escondia ele na tela — o servidor continuava processando e contando ele na fila, o que deixava a numeração errada (ex: mostrar "2/2" com só 1 item real). Agora o cancelamento chega até o servidor.

Se o Ollama devolver um erro rápido (tipo `500`, comum nos modelos `:cloud`), o servidor tenta de novo automaticamente até 2 vezes antes de desistir (mostra "tentando de novo (2/3)…" no card). Isso não se aplica a travamentos longos (timeout) — aí é erro direto, pra não te fazer esperar o dobro/triplo do tempo à toa. Pra mudar o número de tentativas: `OLLAMA_MAX_RETRIES=4 npm start`.

A resposta é renderizada como Markdown: títulos, **negrito**, listas, tabelas e blocos de código com indentação e realce de sintaxe (tema escuro, ~36 linguagens). O texto vai sendo formatado enquanto chega (streaming), sem esperar a resposta terminar. Todo HTML que a IA gerar passa por sanitização (DOMPurify) antes de entrar na página — a imagem capturada pode conter texto malicioso que o modelo transcreva de volta, então nada de `<script>`/`onerror` sobrevive.

As bibliotecas (`marked`, `highlight.js`, `dompurify`) ficam empacotadas como arquivos estáticos em `server/public/vendor/` — não são buscadas de CDN, então funcionam offline/local. Se quiser atualizar essas dependências no futuro: `npm update && npm run build:vendor` (regenera os arquivos em `vendor/`).

## Por que fica lento (medido nesta máquina)

Esta máquina é um i5-1135G7, 4 núcleos, 7,7 GB de RAM, **sem GPU dedicada** (Iris Xe). Ollama roda em CPU. Medições reais:

**Modelo local (`glm-ocr`), tempo só para "olhar" a imagem:**

| Resolução enviada | Processar a imagem |
|---|---|
| 1920px | **167 s** |
| 1280px | **56 s** |

A geração de texto em si roda a ~7,8 tokens/s — ou seja, **o gargalo é processar a imagem, não escrever a resposta**, e ele explode com a resolução. Por isso o seletor **Rápido / Equilibrado / Detalhado** na Página B é a alavanca mais forte que você tem: use "Rápido" (640px) quando não precisar ler texto miúdo.

Sem teto de resposta, o `glm-ocr` chegou a gerar 1999 tokens (transcreveu a tela inteira), levando 5 minutos. O teto padrão de 512 tokens corta isso.

### Por que o `:cloud` demora

Medido em `gemma4:cloud`, e não é um só motivo:

**1. Quando está quente e sem disputa, ele é rápido:** 1,0 s até a primeira palavra e **35,9 tok/s**. Ou seja, o problema não é a velocidade de escrita do modelo.

**2. Partida a frio:** a primeira requisição depois de um tempo parado levou **13,5 s**; as seguintes, 0,27 s. Por isso a Página B pré-carrega o modelo assim que você o seleciona — para esse custo cair antes da sua primeira captura, e não durante.

**3. Fila da infraestrutura compartilhada — o maior fator.** A *mesma* requisição, com a *mesma* imagem, levou tempos completamente diferentes conforme o momento:

`6,3 s · 6,9 s · 8,0 s · 8,3 s · 19,9 s · 51,8 s · 81,4 s · 136,4 s`

Isso é disputa por capacidade no servidor da Ollama. Nenhum ajuste local muda.

**4. Os erros 500 são rejeição por sobrecarga, não falha real** — e são sensíveis ao ritmo dos seus cliques:

| Padrão de envio | Sucesso |
|---|---|
| 5 capturas em rajada | 3/5 |
| 5 capturas espaçadas de 15 s | **5/5** |

Os 500 voltam em ~800 ms (rejeição imediata, não processamento). Por isso o retry usa backoff exponencial começando em 3 s: insistir rápido só toma outra rejeição. **Prática que ajuda de verdade: não metralhar o botão Capturar quando estiver usando modelo `:cloud`.**

Nem todo modelo `:cloud` está acessível: `qwen3.5:cloud` respondeu 403 em todas as tentativas (provavelmente exige `ollama signin` ou assinatura).

**Resumo:** no cloud, o tempo é dominado por fila e rejeições do serviço, não pelo seu código ou sua internet. Para tempo previsível, modelo local; para respostas rápidas quando dá certo, cloud — mas com capturas espaçadas.

**Realidade do hardware:** com 7,7 GB de RAM e sem GPU, análise de imagem local vai levar dezenas de segundos, não 2 s. Não há ajuste de código que mude isso; o que muda de verdade é resolução menor, modelo menor, ou uma GPU.

### Ajustes disponíveis

Todos por variável de ambiente ao iniciar o servidor:

| Variável | Padrão | Efeito |
|---|---|---|
| `OLLAMA_NUM_PREDICT` | 512 | Teto de tokens da resposta. Menor = respostas mais curtas e rápidas. |
| `OLLAMA_NUM_CTX` | 4096 | Contexto. Não abaixe muito: a imagem sozinha consome 1000+ tokens. |
| `OLLAMA_NUM_THREAD` | (automático) | Só defina se souber o que faz — forçar o número de núcleos *lógicos* costuma deixar mais lento. |
| `OLLAMA_TIMEOUT_MS` | 120000 | Tempo até desistir de uma análise travada. |
| `OLLAMA_MAX_RETRIES` | 2 | Tentativas extras em erro rápido (ex: 500). |
| `OLLAMA_RETRY_DELAY_MS` | 3000 | Espera antes da 1ª retentativa; dobra a cada tentativa (3s, 6s). |

Exemplo: `OLLAMA_NUM_PREDICT=200 npm start`

Outras otimizações já aplicadas: o modelo fica carregado na RAM por 30 min e é pré-carregado assim que você escolhe no seletor (tira o custo de carga da primeira captura); a Página B recebe só uma miniatura de 320px por captura em vez da imagem cheia (economiza ~140 KB por captura no celular), buscando a imagem completa só quando você toca nela. Cada resposta mostra no rodapé o tempo real gasto, incluindo quanto foi só processando a imagem.

## Notas de segurança

- O servidor escuta em `0.0.0.0` (por pedido seu, pra alcançar o celular) — isso expõe a porta 8787 pra qualquer dispositivo na mesma rede, não só o seu celular. Com o token isso fica protegido de acesso casual, mas evite rodar isso em Wi-Fi pública/compartilhada.
- Nada é persistido em disco além do `.token`; a pilha de respostas na Página B vive só na memória da aba (some ao recarregar).
