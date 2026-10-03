# Processamento de áudio

## Linux com CPU

Use Python 3.11 ou 3.12, `ffmpeg` no PATH e um único ambiente virtual para todas as ferramentas. Os ambientes virtuais criados no macOS não podem ser copiados para Linux.

```sh
python3 -m venv server/.media-venv
server/.media-venv/bin/python -m pip install --no-cache-dir -r server/requirements-stems-cpu.txt
```

Esse arquivo inclui importação do YouTube, detecção de tom, transcrição e separação em seis instrumentos. As versões de PyTorch e TorchVision são explicitamente de CPU para evitar instalar bibliotecas CUDA. Para instalar apenas importação, tom e transcrição, use `requirements-linux-cpu.txt`.

Se já houver um ambiente Python 3.12 com `torch==2.14.0+cpu`, é possível compartilhá-lo por um arquivo `.pth` no novo ambiente, usando o mesmo Python. O ambiente existente deve permanecer disponível e somente para leitura. Instale os pacotes adicionais no novo ambiente e execute `pip check` antes de ativar o serviço. Não use `pip --upgrade` no ambiente compartilhado.

Configure os caminhos absolutos no ambiente do serviço:

```dotenv
PYTHON_BIN=/caminho/do/app/server/.media-venv/bin/python
STEM_PYTHON_BIN=/caminho/do/app/server/.media-venv/bin/python
LYRICS_PYTHON_BIN=/caminho/do/app/server/.media-venv/bin/python
SEPARATOR_BIN=/caminho/do/app/server/.media-venv/bin/audio-separator
LYRICS_BACKEND=faster-whisper
LYRICS_MODEL=small
LYRICS_CPU_THREADS=2
LYRICS_MODEL_DIR=/caminho/do/app/server/models/whisper
```

`small` é multilíngue e funciona em português. O modelo é baixado no primeiro uso; também é possível definir `LYRICS_MODEL` como o caminho de um modelo CTranslate2 já instalado. Reserve espaço para o modelo e para os arquivos temporários de áudio. O pacote faster-whisper não precisa de PyTorch.

A separação usa `htdemucs_6s.yaml`, com modelos em `server/models`. Preserve os arquivos existentes dessa pasta ao migrar ou permita o download inicial. A API mantém os trabalhos em memória; evite reiniciar o processo durante a geração de letras ou instrumentos.

Em uma máquina com pouco disco, use `--no-cache-dir`, compartilhe o PyTorch compatível existente e mantenha uma margem para novos áudios. Não instale três ambientes separados com as mesmas bibliotecas.

As dependências de importação e detecção de tom em `requirements-media.txt`
devem existir no próprio ambiente do Louwy. Em 02/10/2026, a remoção do ambiente
referenciado por um `.pth` externo deixou `numpy` e dependências transitivas
indisponíveis. Para reparar somente essas etapas, execute a instalação de
`requirements-media.txt` no `PYTHON_BIN` do serviço e verifique os imports de
`numpy`, `librosa` e `yt_dlp` como usuário `louwy`, além de um teste real de áudio.
Evite considerar apenas `import librosa` como validação: esse pacote importa
parte das dependências de forma tardia.

O YouTube usa Node.js por `YTDLP_JS_RUNTIME`, o componente de extração
`YTDLP_REMOTE_COMPONENTS` e, quando configurados, `YTDLP_PROXY` e
`YTDLP_COOKIES_FILE`. Os mesmos argumentos são usados para metadados e download.
O plugin `bgutil-ytdlp-pot-provider==2.0.1` permite obter tokens do serviço
configurado por `YTDLP_POT_PROVIDER_URL`. O plugin, por si só, não resolve
bloqueios de IP. `YTDLP_EXTRACTOR_ARGS` seleciona os argumentos de extração,
e `YTDLP_CACHE_DIR` permite escolher um cache gravável. Metadados, áudio e
a repetição após reiniciar precisam passar antes de adotar uma nova rota.
Uma queda do proxy deve ser reparada na conexão, sem desativar a configuração
e enviar automaticamente as mesmas tentativas pelo IP bloqueado do servidor.

## macOS com Apple Silicon

A transcrição continua usando `mlx-whisper` e `mlx-community/whisper-large-v3-turbo-q4` por padrão. As dependências estão em `requirements-lyrics-macos.txt`. `LYRICS_BACKEND=mlx` força esse backend; `LYRICS_BACKEND=faster-whisper` força a versão de CPU.

## Teste sem baixar modelos

```sh
python3 -m unittest server/test_transcribe_lyrics.py -v
```

Os testes verificam a escolha do backend, o formato JSON e os tempos das palavras usando modelos simulados. Um teste real de transcrição e separação ainda é necessário no servidor após instalar os pacotes e os modelos.

Referências: [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [audio-separator](https://github.com/nomadkaraoke/python-audio-separator), [PyTorch 2.14 e TorchVision 0.29](https://pytorch.org/blog/pytorch-2-14-release-blog/).
