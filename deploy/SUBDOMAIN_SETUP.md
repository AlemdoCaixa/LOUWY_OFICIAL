# Subdomínios por igreja

## DNS no Registro.br

Crie um registro `A`:

- Nome: `*`
- Destino: `77.42.46.50`
- TTL: padrão

Isso fará endereços como `primicias.louwy.com.br` e `esperanca.louwy.com.br` apontarem para o servidor.

## HTTPS wildcard

É necessário emitir um certificado para:

- `louwy.com.br`
- `*.louwy.com.br`

A emissão exige desafio DNS-01, criando temporariamente um TXT em `_acme-challenge.louwy.com.br`. Depois, instale o certificado em `/etc/letsencrypt/live/louwy-wildcard/`.

## Ativação

1. Copie `louwy-subdomains.nginx.template` para `/etc/nginx/sites-available/louwy-subdomains`.
2. Crie o link em `/etc/nginx/sites-enabled/`.
3. Execute `nginx -t` antes de recarregar.
4. Recompile o frontend com `VITE_CHURCH_SUBDOMAINS=true npm run build`.
5. Publique o novo `dist` e teste duas igrejas diferentes.

Até essa etapa ser concluída, o modo multi-igrejas funciona no domínio principal usando o identificador salvo no navegador.
