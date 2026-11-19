# Suporte operacional

Este arquivo substitui instruções antigas de outro bot que não correspondem ao coletor de alinhamentos atual. Para a configuração atual, siga o [README](README.md) e o [Início rápido](QUICK-START.md).

## Google Sheets

Confirme `SPREADSHEET_ID` e `CONFIG_SPREADSHEET_ID`. A conta de serviço anexada à VM precisa de leitura na planilha de referências e edição na planilha de registros. O código usa Application Default Credentials; não recrie nem distribua chaves privadas como arquivos.

## Gemini

Configure `GEMINI_API_KEY` como segredo de runtime e mantenha `GEMINI_CONVERSATION_ENABLED=true`. Não imprima a chave em logs ou a inclua em issues, commits ou pull requests.

## WhatsApp e dados locais

A pasta `auth_info_baileys/` mantém a sessão autenticada. Preserve-a durante atualizações. Os arquivos de sessões, confirmações e pendências podem conter dados operacionais; mantenha-os fora do Git e limite o acesso.

## Publicação

Faça alterações em branch e revise em pull request. Antes de atualizar a VM, confira a versão aprovada, as variáveis de runtime e os cabeçalhos da aba `Modelo alinhamento`.
