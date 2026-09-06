# ConsultaMed 2.6

Versão web do ConsultaMed preparada para Cloudflare Pages.

## Estrutura

- `public/` — site que o usuário abre.
- `functions/` — consultas feitas no servidor da Cloudflare.
- `functions/api/search.js` — consulta Consulta Remédios e BASE.

## Publicar no Cloudflare Pages

Use:

- Ramificação de produção: `main`
- Comando de build: deixe vazio
- Diretório de saída: `public`

O endereço `*.pages.dev` fica fixo após a criação do projeto.

## BASE

O link pode continuar sendo `*.trycloudflare.com` e mudar quando necessário. A URL é informada na tela do ConsultaMed.

Por segurança, o backend aceita apenas URLs HTTPS de `urlshort.at` e `*.trycloudflare.com`.
