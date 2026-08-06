// Gera server/public/vendor/*.js a partir dos pacotes npm. Os pacotes do
// marked/highlight.js/dompurify não vêm prontos para <script> sem bundler
// (exceto o marked, que já tem um build UMD) — então empacotamos aqui uma
// vez e servimos os arquivos estáticos gerados, sem precisar de build no
// servidor a cada início.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'public', 'vendor');
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  await esbuild.build({
    entryPoints: [require.resolve('highlight.js/lib/common')],
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'hljs',
    outfile: path.join(OUT, 'hljs.min.js')
  });

  // marked não expõe lib/marked.umd.js no campo "exports" do package.json,
  // então resolve a raiz do pacote e monta o caminho manualmente.
  const markedRoot = path.dirname(require.resolve('marked/package.json'));

  await esbuild.build({
    entryPoints: [path.join(markedRoot, 'lib', 'marked.umd.js')],
    minify: true,
    format: 'iife',
    outfile: path.join(OUT, 'marked.min.js')
  });

  fs.copyFileSync(
    require.resolve('dompurify/dist/purify.min.js'),
    path.join(OUT, 'dompurify.min.js')
  );
  fs.copyFileSync(
    require.resolve('highlight.js/styles/atom-one-dark.min.css'),
    path.join(OUT, 'hljs-theme.css')
  );

  // katex já publica um build de browser pronto (define window.katex) —
  // só copia. Os fonts vêm junto porque o CSS os referencia por @font-face.
  const katexRoot = path.dirname(require.resolve('katex/package.json'));
  fs.copyFileSync(path.join(katexRoot, 'dist', 'katex.min.js'), path.join(OUT, 'katex.min.js'));
  fs.copyFileSync(path.join(katexRoot, 'dist', 'katex.min.css'), path.join(OUT, 'katex.min.css'));
  fs.cpSync(path.join(katexRoot, 'dist', 'fonts'), path.join(OUT, 'fonts'), { recursive: true });

  // Mesmo caso do marked: marked-katex-extension não expõe lib/index.umd.js
  // no campo "exports", então resolve a raiz do pacote e monta o caminho.
  const markedKatexRoot = path.dirname(require.resolve('marked-katex-extension/package.json'));
  fs.copyFileSync(
    path.join(markedKatexRoot, 'lib', 'index.umd.js'),
    path.join(OUT, 'marked-katex.min.js')
  );

  console.log('vendor bundles gerados em public/vendor/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
