# Louwy

Aplicativo React/PWA multi-igrejas para equipes, eventos, repertórios e preparação musical. O backend usa Node.js, Express e PostgreSQL. Cada igreja possui master, catálogo, membros, equipes, eventos e arquivos isolados.

## Desenvolvimento

Use Node.js 22 e PostgreSQL. Configure `DATABASE_URL` em `.env.local`, instale as dependências com `npm ci` e execute `npm run dev:all`.

A API usa `127.0.0.1:5174`. O Vite encaminha API e mídia para essa porta. Consulte `server/MEDIA_RUNTIME.md` para configurar os recursos de áudio.

## Verificação

```sh
npm test
npm run test:lyrics
npm run test:multi-church
npm run test:multi-church-ui
npm run lint
npm run build
```

O teste HTTP usa arquivos e estado temporários, sem acessar o banco real. Para testar a interface, execute `npm run dev -- --port 5191` em outro terminal e depois `npm run test:auth-ui`. Ele usa Chrome e respostas simuladas, sem alterar dados reais. Defina `CHROME_BIN` para outro executável Chrome e `QA_FRONTEND_URL` para outra porta.

## Dados e produção

O estado por igreja está em `churches` e `church_state`. `app_state` permanece como origem legada e segurança de migração. Os arquivos de áudio, stems, anexos, logos e avatares são separados em subpastas pelo ID da igreja. Um backup completo inclui banco, `server/data` (inclusive `auth-secret.txt`) e `server/models`.

O deploy de 27/09/2026 usa `louwy.service` e Nginx. Consulte `DEPLOYMENT.md` para os caminhos de produção e o procedimento de retorno.
