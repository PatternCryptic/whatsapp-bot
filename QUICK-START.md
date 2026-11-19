# Início rápido — Bot de alinhamentos

Consulte o [README](README.md) para a descrição atual, os IDs oficiais das planilhas e as variáveis de ambiente. Não mantenha cópias divergentes desses IDs neste guia.

## Ambiente de produção

O serviço atual roda em uma VM do Compute Engine sob `systemd`. Configure `SPREADSHEET_ID`, `CONFIG_SPREADSHEET_ID`, `GEMINI_CONVERSATION_ENABLED=true` e `GEMINI_API_KEY` no ambiente seguro do serviço. Escolha `GEMINI_MODEL` se necessário; o padrão é `gemini-3.1-flash-lite`.

A VM deve usar a conta de serviço anexada via Application Default Credentials. Dê a ela leitura na planilha de referências e edição na planilha de registros. Não coloque chaves privadas no GitHub nem em arquivos do projeto.

Instale dependências com `npm install` e inicie com `npm start`. Antes de trocar a versão em produção, valide o destino e os cabeçalhos da aba `Modelo alinhamento` e preserve os arquivos locais privados do serviço, como `auth_info_baileys/`, `alignment-sessions.json`, `alignment-confirmations.json` e `pending-alignment.jsonl`.
