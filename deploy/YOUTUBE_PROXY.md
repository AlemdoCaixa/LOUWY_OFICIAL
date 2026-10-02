# Proxy de importação do YouTube — 02/10/2026

## Diagnóstico

O backend e o banco PostgreSQL do Louwy estavam ativos. A importação não utiliza
Supabase. `YTDLP_PROXY` apontava para `socks5h://127.0.0.1:11881`, mas nenhum
processo escutava nessa porta. Os logs de 02/10 mostravam recusa de conexão
antes da extração de metadados. Testes sem proxy em IPv4 e IPv6 retornaram
`Sign in to confirm you're not a bot`.

O MacBook Air conectado à integração antiga estava offline. Não foi possível
comprovar que ele hospedava o túnel anterior; não havia serviço de proxy
registrado no systemd do servidor.

## Conexão recuperada

O responsável autorizou o uso da internet do Mac atual. Uma chave exclusiva
autentica `louwy-proxy@77.42.46.50`. A conta não permite shell, PTY,
encaminhamento local, encaminhamento do agente nem X11. A única porta remota
permitida é `127.0.0.1:11881`; ela não fica exposta na interface pública.

Configuração SSH do servidor:
`/etc/ssh/sshd_config.d/60-louwy-youtube-proxy.conf`.
Chave pública restrita: `/home/louwy-proxy/.ssh/authorized_keys`.
O arquivo `runtime.env` do Louwy mantém os parâmetros existentes de proxy,
Node e componentes EJS. Não foram obtidos nem exportados cookies de navegador.

No Mac autorizado, os arquivos privados e o supervisor ficam em
`/Users/rubituci/Documents/Codex/louwy-proxy`. A chave privada não deve ir para
o Git, relatórios ou arquivos de distribuição. `reconnect.sh` mantém o túnel
e tenta reconectar após 15 segundos; os keepalives detectam quedas da sessão.

## Pendência no login do Mac

Foi preparado `com.louwy.youtube-proxy.plist` com `RunAtLoad`, `KeepAlive`,
`ThrottleInterval=15`, verificação da chave do servidor e credencial exclusiva.
O ambiente do Codex bloqueou escrita em `~/Library/LaunchAgents` e controle
do Terminal, mesmo após a autorização do responsável. O instalador entregue
precisa ser executado pelo usuário para habilitar o início automático no login.
Não considerar essa etapa instalada até verificar o serviço no launchd.

O supervisor em execução mantém reconexão durante a sessão atual. Após instalar
o agente, o instalador encerra o supervisor para evitar dois túneis concorrentes.
O Mac precisa permanecer acordado e online. Para operação independente do Mac,
é necessário substituir essa rota por um proxy de saída permanente autorizado.

## Verificação

1. Confirmar listener apenas em `127.0.0.1:11881` no servidor.
2. Consultar metadados e baixar áudio como usuário `louwy`, usando o mesmo proxy.
3. Testar `POST /api/import` com `asynchronous: true` e consultar
   `GET /api/import-jobs/:jobId` até `ready`.
4. Verificar tom detectado, item único no catálogo, MP3 e leitura parcial HTTP 206.
5. Confirmar duplicata sem novo download e rejeição de domínio imitador do YouTube.

O preflight é uma verificação TCP de disponibilidade do proxy. Não comprova,
sozinho, disponibilidade do YouTube; os testes reais de extração são necessários.
Os testes automatizados cobrem proxy ativo, recusa de conexão, configuração
inválida, erro nas duas modalidades da API e catálogo existente durante a queda.

Referências do extrator: [releases oficiais](https://github.com/yt-dlp/yt-dlp/releases)
e [guia oficial de extração](https://github.com/yt-dlp/yt-dlp/wiki/Extractors).
