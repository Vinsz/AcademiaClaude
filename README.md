# Treino

App web para registrar os treinos A, B, C e D, com pontos, sequência semanal, caminhadas e metas de peso.
Funciona offline e pode ser instalado na tela inicial do celular. Os dados ficam só no aparelho (há exportar/importar backup em Histórico → Dados).

## Como usar no celular

1. Publique a pasta (por exemplo, GitHub Pages: Settings → Pages → branch com estes arquivos, pasta `/`).
2. Abra o endereço no celular.
3. iPhone (Safari): Compartilhar → Adicionar à Tela de Início. Android (Chrome): menu → Instalar app.

Para testar no computador: `python3 -m http.server` nesta pasta e abrir `http://localhost:8000`.

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

- `data.js`: treinos, exercícios, metas, pontos e o histórico inicial (20/10 a 02/11/2026).
- `logic.js`: cálculo de pontos, recordes, sequência, metas e sugestões.
- `app.js`: telas e eventos.
- `sw.js`: cache offline. Ao alterar arquivos, suba a versão em `CACHE`.
