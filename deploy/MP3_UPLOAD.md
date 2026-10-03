# Importação por upload de MP3

A biblioteca e o repertório dos eventos recebem arquivos MP3. O frontend envia
`POST /api/upload-song` com multipart (`audio`, `title`, `artist`) e acompanha
`GET /api/import-jobs/:jobId`. A conta autenticada define autor e igreja.

Limites: um arquivo de até 20 MiB e 2 horas, quatro recebimentos simultâneos,
um recebimento por conta e a fila compartilhada de mídia de até 20 tarefas.
O upload usa disco temporário, não memória, e não bloqueia alterações de equipes
e contas. A validação usa FFprobe e FFmpeg: extensão e MIME não comprovam MP3.
O áudio é decodificado e normalizado para MP3 a 192 kbps, sem capas ou metadados
embutidos. Nome e artista são guardados no catálogo.

O hash SHA-256 dos bytes enviados identifica arquivos idênticos dentro de cada
igreja. Reenvios compartilham o trabalho em andamento ou retornam a faixa já
existente. Gravações diferentes ou arquivos com tags diferentes não são tratados
como idênticos. Cada igreja mantém seu próprio catálogo e diretório de áudio.

Arquivos incompletos e rejeitados são removidos. Entradas temporárias abandonadas
são limpas na inicialização. Após receber o arquivo inteiro e devolver o número
da tarefa, o processamento continua se o usuário fechar a janela. Tarefas não
são persistidas após reinício: confira o catálogo antes de reenviar.

O servidor precisa de `ffmpeg` e `ffprobe` no PATH, podendo configurar
`FFMPEG_BIN` e `FFPROBE_BIN`. A detecção de tom continua usando `STEM_PYTHON_BIN`;
letras e instrumentos usam os runtimes já descritos em `server/MEDIA_RUNTIME.md`.
Não há dependência de yt-dlp, proxy, cookies ou computador pessoal nesse fluxo.

O endpoint antigo de URL retorna HTTP 410 por padrão. `ENABLE_YOUTUBE_IMPORT=true`
é uma opção de compatibilidade explícita para ambientes de teste/legados; o
frontend não oferece esse fluxo. Músicas anteriormente importadas continuam
no catálogo e usando seus arquivos existentes.

Verificação: `npm test`, `npm run test:import`, `npm run test:import-ui`,
`npm run build` e `npm run lint`. Para executar a verificação de mídia real nos
testes de backend, configure `MP3_TEST_FIXTURE` com um MP3 de teste e mantenha
FFmpeg/FFprobe disponíveis. Valide também upload, leitura HTTP 206, duplicata,
arquivo inválido, isolamento entre igrejas e repetição após reinício pela API
publicada. O proxy HTTP deve aceitar o multipart completo (arquivo + campos).
