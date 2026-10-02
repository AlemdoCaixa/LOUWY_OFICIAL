# Operação do proxy de importação do YouTube

O frontend envia uma solicitação assíncrona, acompanha o progresso e recebe a música ou um erro do backend. O extrator utiliza a rota definida em `YTDLP_PROXY` para metadados e download. A indisponibilidade dessa rota deve ser reparada no proxy, sem remover sua configuração e enviar automaticamente as mesmas tentativas pelo IP bloqueado do host.

O backend verifica a disponibilidade TCP do proxy antes de invocar o extrator. Uma porta fechada ou configuração inválida retorna `YOUTUBE_PROXY_UNAVAILABLE`; um erro posterior de conexão também é traduzido para essa categoria. Essa verificação não garante, sozinha, acesso ao YouTube. É necessário testar um vídeo público com as mesmas opções usadas pelo serviço.

Um túnel mantido por uma máquina externa deve ter uma chave exclusiva, verificação da chave do servidor, conta sem shell e encaminhamento limitado ao endereço e à porta necessários. O endereço de escuta deve ser privado. Use keepalives, supervisão e reconexão após falhas de rede.

O uso de um Mac como saída exige que ele esteja acordado e conectado. Para iniciar após login, instale um agente com `RunAtLoad`, `KeepAlive` e intervalo de reinício. O supervisor da sessão atual não substitui o agente de login. Não mantenha dois supervisores concorrendo pela mesma porta.

Em 02/10/2026, a conexão foi recuperada com autorização do responsável. A instalação do agente de login ficou pendente por restrições das ferramentas locais. Os detalhes privados, instalador e instruções de ativação foram entregues ao responsável em relatório local; nenhuma chave privada deve ser publicada no Git.

## Verificação

1. Confirmar a escuta do proxy apenas no endereço privado configurado.
2. Consultar metadados e baixar áudio como o usuário do serviço, pela mesma rota.
3. Testar `POST /api/import` com `asynchronous: true` e consultar `GET /api/import-jobs/:jobId` até `ready`.
4. Verificar tom detectado, item único no catálogo, MP3 e leitura parcial HTTP 206.
5. Confirmar duplicata sem novo download e rejeição de domínio imitador do YouTube.
6. Simular indisponibilidade em teste isolado e confirmar o erro específico nas APIs síncrona e assíncrona.

Referências: [releases oficiais do yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) e [guia oficial de extração](https://github.com/yt-dlp/yt-dlp/wiki/Extractors).
