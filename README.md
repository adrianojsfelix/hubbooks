# HubBooks 📚

Estante pessoal de livros em PDF: leia dentro do app e acompanhe **progresso, status, prazo e checklist** de cada livro. Funciona no PC e no celular (pode ser instalado como app — PWA) e funciona offline.

## Recursos
- **Adicionar PDFs** (botão ou arrastar e soltar). Capa, título, autor e nº de páginas são lidos do arquivo.
- **Leitor integrado** (PDF.js): rolagem contínua, zoom (botões, Ctrl+roda, pinça no celular), ir para página, barra de posição, modo noturno, marcadores, atalhos de teclado (← → Espaço Home End + − 0 Esc). Toque no centro da página esconde as barras no celular.
- **Progresso salvo automaticamente** na página onde você parou.
- **Status**: Quero ler, Lendo, Pausado, Concluído, Abandonado (muda para "Lendo" sozinho ao começar; sugere "Concluído" na última página).
- **Prazo** por livro com dias restantes, alerta de atraso e **ritmo necessário (páginas/dia)**.
- **Visão Checklist**: tabela com caixinha de concluído, status, progresso, prazo e situação editáveis direto na lista.
- **Checklist por livro** (capítulos, metas), com opção de gerar itens a partir do sumário do PDF.
- Anotações, prioridade, data de início.
- **Painel**: totais, atrasados, páginas lidas nos últimos 7 dias e sequência de dias lendo.
- **Backup** (exportar/importar JSON) para levar o progresso a outro aparelho.

## Onde ficam os dados
Tudo fica **no navegador do aparelho** (IndexedDB) — nada é enviado para servidores. Cada aparelho tem sua própria estante; use *Exportar/Importar backup* (menu ⋮) para transferir o progresso e depois anexe o PDF no outro aparelho em "Detalhes".

## Como usar
É um site estático, sem build. Sirva a pasta com qualquer servidor HTTP:

```bash
python3 -m http.server 8000
```

Abra http://localhost:8000. Para usar no celular, publique em um host estático com HTTPS (ex.: GitHub Pages: *Settings → Pages → Deploy from branch*) e use "Adicionar à tela inicial".

## Estrutura
- `index.html`, `styles.css` — interface
- `js/app.js` — estante, painel, detalhes, backup
- `js/reader.js` — leitor de PDF
- `js/pdf.js` — integração com PDF.js
- `js/db.js` — armazenamento IndexedDB
- `sw.js`, `manifest.webmanifest` — app instalável/offline
- `lib/pdfjs/` — PDF.js 4.10.38 (Apache-2.0)
