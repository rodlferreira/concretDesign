# ConcretDesign — API Node.js

Node.js 24+, Express 5, Zod, SQLite nativo e cifragem AES-256-GCM. Sem painel público de administração ou leitura dos pedidos.

```bash
npm ci
cp .env.example .env
npm run dev
npm test
```

`GET /api/health` devolve o estado do processo. `POST /api/quotes` recebe JSON estrito e exige `Idempotency-Key` UUID; responde `201 {reference}` apenas depois de o pedido ficar persistido. A mesma chave e dados devolvem a referência existente; reutilizar a chave com dados diferentes dá 409. Validação ocorre sempre no servidor.

Campos: `name`, `company`, `email`, `location`, `service` (`micro|marmorino|render|mass|finish`), `phone`, `message`, `consent: true`, `locale`, `website: ""` (honeypot). Nome/empresa/localização são obrigatórios; telefone e mensagem são opcionais. Respostas 400, 403, 409, 413, 415 e 429 não expõem detalhes internos nem dados de outros pedidos.

## Persistência, notificações e retenção

Os dados pessoais ficam cifrados na base SQLite; apenas UUIDs e datas operacionais ficam em claro. Em desenvolvimento cria-se uma chave local no diretório privado `data/`. Produção exige uma chave base64 de 32 bytes em `DATA_ENCRYPTION_KEY`; guardar no gestor de segredos e preservar separadamente dos backups. Perder a chave torna os pedidos irrecuperáveis. Não guardar chaves em Git.

Configurar SMTP no `.env` para enviar avisos para `QUOTE_EMAIL` (por defeito `geral@concretdesign.pt`). O remetente `SMTP_FROM` deve ser autorizado pelo fornecedor. O processo verifica pedidos pendentes uma vez por minuto; falhas ficam pendentes para nova tentativa. O transporte usa TLS e os dados entram apenas no corpo de texto. Não são enviados emails ao visitante automaticamente. As notificações são pelo menos uma vez: uma falha após o SMTP aceitar o email e antes da confirmação local pode repetir a notificação, com a mesma referência. Sem SMTP, os pedidos continuam guardados, mas não há avisos por email. Não foram inventadas credenciais nem testado envio para endereços reais.

Pedidos mais antigos que `RETENTION_DAYS` (por defeito 90, máximo 90) são eliminados no arranque e de hora a hora. `npm run purge` permite executar o mesmo processo num agendamento do alojamento, inclusive quando a API estiver parada. Backups e emails recebidos têm de seguir a mesma política de retenção no alojamento e nas caixas de correio. Para acesso/correção/eliminação RGPD, a equipa deve verificar a identidade e operar os dados localmente; não existe endpoint anónimo de leitura/eliminação.

## Segurança operacional

Helmet, limites de tamanho, JSON obrigatório, honeypot, origem e Fetch Metadata validados, campos restritos, queries SQL parametrizadas, UUIDs opacos, cifragem autenticada e permissões locais restritas. Não há cookies de sessão nem autenticação pública. A API permite por defeito 5 pedidos por IP a cada 15 minutos. O frontend conserva a chave de idempotência durante a repetição de um envio falhado. A limitação inclui pedidos inválidos para reduzir abuso.

Configurar `NODE_ENV=production`, `ALLOWED_ORIGINS` com a origem HTTPS exata, `DATA_ENCRYPTION_KEY`, base persistente e SMTP. Servir a API atrás de TLS. Atualmente `trust proxy` está desativado: num reverse proxy, o limite vê o IP do proxy e é partilhado entre visitantes. Para Nginx local, definir `TRUSTED_PROXY_IPS=127.0.0.1,::1,::ffff:127.0.0.1` e usar o exemplo Nginx do frontend, que substitui `X-Forwarded-For` pelo IP da ligação. A configuração aceita apenas IPs explícitos. Não confiar em proxies públicos nem preservar headers fornecidos pelo visitante; nunca ativar `trust proxy: true` indiscriminadamente. A memória do limitador é local ao processo; várias instâncias requerem um store partilhado. SQLite destina-se a uma instância com disco persistente; vários nós exigem outra estratégia de persistência.

Nenhum código elimina todos os riscos. Manter dependências atualizadas, monitorizar, fazer backups cifrados e executar testes. A auditoria npm de dependências de produção foi feita durante a entrega; repetir no CI.

A auditoria completa das dependências de desenvolvimento mantém cinco entradas de baixa gravidade na cadeia Jest → deepmerge, referentes a um único alerta upstream sem versão corrigida. Não são dependências de produção. Ver `SECURITY.md` no frontend para o registo e o link do advisory. Os overrides de glob/minimatch removem os alertas moderados e foram validados com a suíte.

### Dados necessários para ativar o SMTP

Obter do fornecedor que aloja o email `@concretdesign.pt`: servidor SMTP (`SMTP_HOST`), porta (`SMTP_PORT`), tipo de ligação (465 com TLS direto: `SMTP_SECURE=true`; 587 com STARTTLS: `SMTP_SECURE=false`), utilizador completo (`SMTP_USER`), palavra-passe SMTP ou palavra-passe de aplicação (`SMTP_PASSWORD`) e endereço remetente autorizado (`SMTP_FROM`). Confirmar também quem recebe os pedidos (`QUOTE_EMAIL`, já definido como `geral@concretdesign.pt`). Configurar os valores sensíveis apenas no `.env` local do backend ou no gestor de segredos do alojamento, nunca no chat, frontend ou Git. Um fornecedor que exija apenas OAuth requer adaptação da autenticação atual.
