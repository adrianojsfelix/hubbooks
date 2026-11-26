# HubDrive 📚

Seus **livros (PDF)** e **cursos em vídeo** do Google Drive em um só lugar: leia e assista dentro do app e acompanhe **progresso, status, prazo e checklist** de cada um. Funciona no PC e no celular (pode ser instalado como app — PWA) e funciona offline.

## Novidades
- **Google Drive**: importa os PDFs da sua pasta de leitura (subpastas viram coleções; pastas "LIDOS" entram como concluídos). Os PDFs são baixados só quando você abre o livro e ficam disponíveis offline.
- **Sincronização entre PC e celular** do progresso, status, prazos, checklists e notas (via pasta privada do app no seu Drive).
- **"Continue de onde parou"**, **meta diária de páginas**, tempo de leitura e estimativa de tempo para terminar.
- Novo visual: capas em formato de livro, tipografia serifada, prazos rápidos (1 semana, 2 semanas, 1 mês), marcadores na barra do leitor.

## Cursos (aba "Cursos")
- Adicione a pasta de um curso do Google Drive (cole o link ou busque pelo nome) e escolha quais módulos entram.
- As aulas (vídeos) viram um **checklist por módulo e tópico**, com progresso, tempo restante e destaque da aula atual.
- **Assista dentro do app**: o vídeo é transmitido direto do Drive, lembra onde você parou, tem controle de velocidade e marca a aula como assistida ao chegar em 90%. Ao terminar, oferece a próxima aula.
- PDFs da aula abrem no leitor do HubDrive; pastas só com PDFs (apostilas) viram itens do checklist.
- **Mapas mentais**: escolha a pasta com as imagens (ex.: SEGURIDADE SOCIAL); cada mapa aparece na aula correspondente pelo nome (ou vincule manualmente) e abre em tela cheia com zoom.
- Anotações por aula e “marcar todas até esta como assistidas” para quem já está no meio do curso.
- Atalhos: Espaço (play/pausa), ← → (10 s), N/P (próxima/anterior), M (marcar).

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

## Conectar ao Google Drive
O app roda todo no navegador, então precisa de um **ID do cliente OAuth** do Google (gratuito, feito uma vez):

1. Em https://console.cloud.google.com crie um projeto e ative a **Google Drive API**.
2. **Tela de consentimento OAuth**: tipo *Externo*, adicione seu e-mail como *usuário de teste*.
3. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**. Em *Origens JavaScript autorizadas*, adicione o endereço onde o app está publicado (ex.: `https://SEU-USUARIO.github.io`) e, para testes, `http://localhost:8000`.
4. Cole o ID em `js/config.js` (`googleClientId`) ou na tela “Google Drive” do app.

Permissões pedidas: leitura dos arquivos (`drive.readonly`) e a pasta privada do app (`drive.appdata`) para guardar o progresso. Nada é alterado nas suas pastas.

## Onde ficam os dados
Os PDFs e o progresso ficam **no navegador do aparelho** (IndexedDB). Com o Google Drive conectado, o progresso é copiado para a pasta privada do app no **seu** Drive e sincronizado entre aparelhos. Sem Drive, use *Exportar/Importar backup* (menu ⋮).

## Publicação (GitHub Pages)
O workflow `.github/workflows/pages.yml` publica o app automaticamente a cada atualização do branch `main`.
Uma única vez: no GitHub, **Settings → Pages → Build and deployment → Source: GitHub Actions**.
O endereço fica `https://adrianojsfelix.github.io/hubbooks/` (ou o novo nome, se o repositório for renomeado).
Lembre de adicionar esse endereço (`https://adrianojsfelix.github.io`) nas *Origens JavaScript autorizadas* do ID do cliente OAuth.

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
- `js/drive.js`, `js/config.js` — Google Drive (importação e sincronização)
- `sw.js`, `manifest.webmanifest` — app instalável/offline
- `lib/pdfjs/` — PDF.js 4.10.38 (Apache-2.0)
