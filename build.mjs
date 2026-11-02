// Junta tudo num único HTML (dist/treino.html), sem dependências.
// Serve para abrir direto no navegador ou publicar como página no claude.ai.
// Uso: node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const strip = (src) => src
  .replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, '')
  .replace(/^export\s+/gm, '');

const js = ['data.js', 'logic.js', 'app.js'].map((f) => `// ---- ${f} ----\n${strip(read(f))}`).join('\n');
const css = read('styles.css');
const body = read('index.html').match(/<body>([\s\S]*?)<script/)[1];

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Diário de Treino</title>
<style>
${css}
</style>
</head>
<body>${body}<script>window.SINGLE_FILE = true;</script>
<script type="module">
${js}
</script>
</body>
</html>
`;

// Versão para o claude.ai: o próprio site adiciona doctype/head/body.
const artifact = `<title>Diário de Treino</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
</style>
${body}<script>window.SINGLE_FILE = true;</script>
<script type="module">
${js}
</script>
`;

mkdirSync(new URL('dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('dist/treino.html', import.meta.url), html);
writeFileSync(new URL('dist/treino-claude.html', import.meta.url), artifact);
console.log(`dist/treino.html: ${(html.length / 1024).toFixed(1)} KB`);
console.log(`dist/treino-claude.html: ${(artifact.length / 1024).toFixed(1)} KB`);
