# Operação do proxy de importação do YouTube

O frontend envia uma solicitação assíncrona, acompanha o progresso e recebe a música ou um erro do backend. O extrator utiliza a rota definida em `YTDLP_PROXY` para metadados e download. A indisponibilidade dessa rota deve ser reparada no proxy, sem remover sua configuração e enviar automaticamente as mesmas tentativas pelo IP bloqueado do host.

O backend verifica a disponibilidade TCP do proxy antes de invocar o extrator. Uma porta fechada ou configuração inválida retorna `YOUTUBE_PROXY_UNAVAILABLE`; um erro posterior de conexão também é traduzido para essa categoria. Essa verificação não garante, sozinha, acesso ao YouTube. É necessário testar um vídeo público com as mesmas opções usadas pelo serviço.

A solução definitiva deve operar com supervisão e reinício automático no servidor. A saída de internet usada pelo extrator precisa passar por testes reais de metadados e download: um proxy acessível, sozinho, não resolve um bloqueio do YouTube.

Em 02/10/2026, o túnel por uma máquina externa recuperou duas importações reais apenas temporariamente. Ele não atende ao requisito de independência do computador pessoal e não deve ser tratado como solução definitiva. O acesso direto do servidor e a alternativa Cloudflare WARP retornaram a verificação de robô do YouTube. Uma consulta por WireGuard respondeu, mas o teste após reiniciar voltou a ser bloqueado, inclusive em IPv4 e com outro cliente de extração. Essa alternativa não foi aprovada para produção. A configuração definitiva depende de uma rota aceita pelo provedor, ainda não validada.

Ao configurar um serviço de proxy, mantenha credenciais no ambiente privado do servidor, fora do Git e dos logs. Restrinja a escuta local, limite recursos, configure reinício automático e valide o fluxo completo antes de substituir a rota em produção. Não instale um agente no computador pessoal para atender a esse requisito.

## Verificação

1. Confirmar a escuta do proxy apenas no endereço privado configurado.
2. Consultar metadados e baixar áudio como o usuário do serviço, pela mesma rota.
3. Testar `POST /api/import` com `asynchronous: true` e consultar `GET /api/import-jobs/:jobId` até `ready`.
4. Verificar tom detectado, item único no catálogo, MP3 e leitura parcial HTTP 206.
5. Confirmar duplicata sem novo download e rejeição de domínio imitador do YouTube.
6. Simular indisponibilidade em teste isolado e confirmar o erro específico nas APIs síncrona e assíncrona.

Referências: [releases oficiais do yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) e [guia oficial de extração](https://github.com/yt-dlp/yt-dlp/wiki/Extractors).
