# Operação do proxy de importação do YouTube

O frontend envia uma solicitação assíncrona, acompanha o progresso e recebe a música ou um erro do backend. O extrator utiliza a rota definida em `YTDLP_PROXY` para metadados e download. A indisponibilidade dessa rota deve ser reparada no proxy, sem remover sua configuração e enviar automaticamente as mesmas tentativas pelo IP bloqueado do host.

O backend verifica a disponibilidade TCP do proxy antes de invocar o extrator. Uma porta fechada ou configuração inválida retorna `YOUTUBE_PROXY_UNAVAILABLE`; um erro posterior de conexão também é traduzido para essa categoria. Essa verificação não garante, sozinha, acesso ao YouTube. É necessário testar um vídeo público com as mesmas opções usadas pelo serviço.

A solução definitiva deve operar com supervisão e reinício automático no servidor. A saída de internet usada pelo extrator precisa passar por testes reais de metadados e download: um proxy acessível, sozinho, não resolve um bloqueio do YouTube.

Em 02/10/2026, o acesso direto e WARP sem tokens retornaram a verificação de robô. WARP combinado com `mweb` e o provedor BgUtils 2.0.1 respondeu a consultas de metadados e a um download completo. Porém, após reiniciar os componentes, as repetições e a importação pela API falharam com HTTP 403 no áudio. Essa alternativa gratuita não foi validada como solução definitiva. O perfil em `youtube-egress/` é experimental e deve ficar desativado até ser validado na rede de destino.

O backend aceita `YTDLP_EXTRACTOR_ARGS` para selecionar o cliente do extrator e `YTDLP_POT_PROVIDER_URL` para usar um provedor de tokens instalado no próprio servidor. Os mesmos argumentos são usados nos metadados e no download; ambos os serviços exigidos são verificados antes de iniciar. O cache fica em `server/data/yt-dlp-cache`, ou em `YTDLP_CACHE_DIR`, com acesso de escrita pelo usuário do serviço. O download prioriza `bestaudio/best`, evitando baixar vídeo quando houver áudio separado. HTTP 403 no download é apresentado como bloqueio do YouTube.

Para uma saída contratada, configure `YTDLP_PROXY` no ambiente privado do servidor com o endpoint e a sessão estável do provedor. A integração com o provedor de tokens consegue usar esse mesmo proxy. Valide dois vídeos inteiros, a importação pela API e a repetição após reiniciar os serviços antes de considerar a recuperação concluída. Nenhum teste unitário substitui essa validação. Não publique credenciais, tokens, cookies nem logs completos do provedor.

Ao configurar um serviço de proxy, mantenha credenciais no ambiente privado do servidor, fora do Git e dos logs. Restrinja a escuta local, limite recursos, configure reinício automático e valide o fluxo completo antes de substituir a rota em produção. Não instale um agente no computador pessoal para atender a esse requisito.

## Verificação

1. Confirmar a escuta do proxy apenas no endereço privado configurado.
2. Consultar metadados e baixar áudio como o usuário do serviço, pela mesma rota.
3. Testar `POST /api/import` com `asynchronous: true` e consultar `GET /api/import-jobs/:jobId` até `ready`.
4. Verificar tom detectado, item único no catálogo, MP3 e leitura parcial HTTP 206.
5. Confirmar duplicata sem novo download e rejeição de domínio imitador do YouTube.
6. Simular indisponibilidade em teste isolado e confirmar o erro específico nas APIs síncrona e assíncrona.

Referências: [releases oficiais do yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) e [guia oficial de extração](https://github.com/yt-dlp/yt-dlp/wiki/Extractors).
