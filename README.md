# Treino

App para registrar os treinos A, B, C e D, com pontos, sequência semanal, caminhadas e metas de peso.

## Onde usar

**Página privada no claude.ai (principal).** `dist/treino-claude.html` publicado como artifact.
Os dados ficam na conta do claude.ai, visíveis só para o dono (regra de acesso `owner` na raiz),
e aparecem em qualquer aparelho. Backup em Histórico → Dados → Exportar.

**Arquivo único.** `dist/treino.html` abre direto no navegador (notebook). Os dados ficam no navegador
daquele aparelho. Para trazer o histórico, importe `historico-inicial.json` ou um backup exportado.

**Site (opcional).** `index.html` + arquivos funcionam como app instalável (PWA) se publicados.
O histórico não está no código, então o site publicado não expõe dados pessoais.

Para gerar os arquivos de `dist/` depois de mudar o código: `node build.mjs`.

## Regras

| Ação | Pontos |
|---|---|
| Treino A, B ou C | 100 |
| Treino D (casa) | 60 |
| Treino incompleto | proporcional, mínimo 40 |
| Recorde (carga ou reps) | +25 cada |
| Caminhada | 10 |
| Pesagem da semana | 20 |

- Novo nível a cada 500 pontos. Nada tira pontos; treino com dor vale o mesmo.
- Semana completa = 3 treinos (segunda a domingo). 1 escudo a cada 4 semanas completas protege a sequência numa semana ruim.
- Caminhadas: meta começa em 3 por semana e sobe +2 depois de 2 semanas batidas, até 14.
- Peso: marcos de −5%, −10% e 80 kg, pela média das últimas 3 pesagens.
- Sugestão de progressão: todas as séries no topo da faixa → subir carga; degrau grande da máquina → subir reps antes; dor na última sessão → manter.

## Arquivos

- `data.js`: treinos, exercícios, metas e pontos.
- `historico-inicial.json`: histórico de 20/10 a 02/11/2026 no formato de backup.
- `build.mjs`: gera `dist/treino.html` e `dist/treino-claude.html`.
- `logic.js`: cálculo de pontos, recordes, sequência, metas e sugestões.
- `app.js`: telas, eventos e armazenamento (conta do claude.ai ou navegador).
- `sw.js`: cache offline. Ao alterar arquivos, suba a versão em `CACHE`.
