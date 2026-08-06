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

  console.log('vendor bundles gerados em public/vendor/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
