# Produção — 27/09/2026

Servidor: `root@77.42.46.50`.

| Endereço | Sistema |
| --- | --- |
| `https://louwy.com.br` | Este aplicativo Louwy |
| `https://permatch.com.br` | Editor de moldura anteriormente em louwy.com.br |
| `https://permatch.com.br/loja` | Plataforma de lojas anteriormente na raiz de permatch.com.br |

## Louwy

- Release ativa: `/opt/louwy/releases/20260927T202401Z-multichurch`, apontada por `/opt/louwy/current`.
- Release anterior preservada para retorno: `/opt/louwy/releases/20260927-qa`.
- Dados, modelos e ambiente: `/opt/louwy/shared`.
- Serviço: `louwy.service`, usuário `louwy`, API em `127.0.0.1:5174`.
- Banco dedicado: `louwy`, com autenticação local PostgreSQL por usuário de sistema.
- Multi-igrejas: metadados em `churches`; estado isolado por igreja em `church_state`.
- Igreja migrada: `primicias`, preservando todos os membros, eventos, equipes e músicas anteriores.
- Python: `/opt/louwy/venv`; pacotes CPU existentes são reutilizados sem alterar o ambiente do outro aplicativo.
- Acesso de leitura/travessia às bibliotecas compartilhadas é limitado ao usuário `louwy` por ACL.
- Limites: um processo de mídia por vez, fila de até 20, serviço limitado a dois núcleos e 5 GB de memória.
- Verifique `df -h /` antes de ampliar o uso: modelos e uploads precisam de espaço.

## Multi-igrejas e subdomínios

A versão publicada já permite cadastrar igrejas e operar várias organizações pelo domínio principal, usando o identificador salvo no navegador. Cada igreja tem master e catálogo próprios; líderes administram apenas suas equipes. Outras equipes veem somente título, data, horário, local e equipe na agenda, sem acesso ao grupo do evento.

Para ativar endereços como `primicias.louwy.com.br`, ainda são necessários:

1. Registro DNS `A` com nome `*` apontando para `77.42.46.50`.
2. Certificado TLS wildcard para `*.louwy.com.br` por desafio DNS.
3. Bloco Nginx com `server_name *.louwy.com.br`.
4. Novo build com `VITE_CHURCH_SUBDOMAINS=true`.

Enquanto isso, o cadastro e a troca de igreja funcionam em `https://louwy.com.br` sem misturar dados.

## Loja e editor de moldura

- Editor: `/var/www/permatch-moldura`.
- Loja com prefixo: container `permatch-loja-20260927`, porta interna `3352`.
- Código e release da loja: `/opt/permatch-loja/source` e `/opt/permatch-loja/release-20260927`.
- A loja compartilha o banco existente. O serviço anterior continua atendendo APIs e subdomínios.
- Rotas antigas de login, painel e cadastro redirecionam para `/loja`.
- URLs de integração, callbacks e storage foram preservadas.

## Backups e retorno

Configurações anteriores, editor original e dump do banco da loja:
`/root/migration-louwy-20260927`.

Para retornar os domínios à configuração anterior, restaure os arquivos
`louwy.com.br` e `permatch.com.br` desse diretório para
`/etc/nginx/sites-available/`, execute `nginx -t` e recarregue o Nginx
somente se a validação passar. Os sistemas antigos e seu banco continuam disponíveis.

O snapshot anterior à migração multi-igrejas está em `/root/migration-louwy-20260927/louwy-before-multichurch-20260927T202401Z.dump`.

O banco inicial do Louwy também foi preservado em `/opt/louwy/louvelab-initial.dump`
e em SQL compatível com o PostgreSQL do servidor. Salve as alterações feitas após
o deploy antes de restaurar esse snapshot sobre o banco ativo.

## Verificação operacional

```sh
systemctl status louwy
journalctl -u louwy --since '10 minutes ago'
curl -fsS https://louwy.com.br/api/health
docker logs --tail 50 permatch-loja-20260927
nginx -t
df -h /
```

A importação do YouTube depende das restrições do provedor. No teste do servidor,
houve bloqueio que exige verificação pelo YouTube; os áudios já armazenados permanecem disponíveis.
