# Coletor de alinhamentos

Bot de WhatsApp que só inicia a análise quando alguém menciona o bot em um grupo. O Gemini interpreta mensagens, relatórios e imagens, compara os dados com os cabeçalhos da planilha e pede validação antes de gravar.

## Funcionamento

- Antes da menção, o bot mantém em memória uma janela das mensagens recentes para usar como contexto quando for chamado. Depois da menção, acompanha aquele grupo por até duas horas. As sessões são isoladas por grupo e equipamento.
- O Gemini considera o texto, o título do grupo, a taxonomia, o glossário e as combinações de máquinas da planilha de configuração.
- Anexos JPEG, PNG, WebP e PDF são enviados ao Gemini para leitura. Relatórios com vários equipamentos geram uma proposta para cada equipamento. Anexos acima de 20 MB ou em formatos não suportados ficam pendentes para revisão.
- PDFs com vários geradores recebem uma segunda leitura focada no GAP final de cada conjunto. Folga do virabrequim, pré-GAP e valores anteriores ao alinhamento não entram na coluna `Coupling GAP`.
- A cada cinco minutos, o Gemini compara as mensagens e os anexos com os cabeçalhos reais da aba `Modelo alinhamento`. A conferência indica o destino, mostra os campos a gravar, identifica valores mantidos e apresenta o restante como `não informado`. Campos sem valor informado ficam vazios na planilha.
- Responda diretamente à mensagem de conferência com `confirmo` para aprovar todos os dados apresentados. Para corrigir ou completar campos, use o formato `Axial Vertical: -0,01 mm`. O bot apresenta a lista completa novamente e aguarda uma nova confirmação.
- Se a pessoa confirmar os dados com uma divergência entre legenda e imagem ainda marcada, a célula recebe `usuário passou informação divergente` e a diferença fica nas observações.
- Se embarcação ou equipamento ainda estiverem como `não informado`, o bot pede esses dados e não grava até poder identificar o registro com segurança.
- O mesmo equipamento na mesma embarcação usa a linha existente, inclusive depois de duas horas. Se houver várias linhas históricas, a sessão ou uma data completa e única identifica a linha. Se o destino ficar ambíguo, ou mudar após a conferência, o bot pede nova validação antes de gravar.
- Uma linha nova exige equipamento ainda não registrado na embarcação e confirmação explícita da proposta. Aguarde duas horas após a última inclusão identificável do bot para outro equipamento na mesma embarcação. Esse intervalo usa o horário guardado em `Comments` e não se aplica a linhas antigas sem esse horário.
- Tolerâncias e medições são extraídas separadamente. O código não calcula valores nem conclui aceitabilidade sem dados compatíveis.

## Planilhas e permissões

Quando houver linhas da mesma embarcação com `Equipment / Tag` vazio, o bot pede esclarecimento antes de criar uma linha. A mensagem lista as linhas candidatas. Responda diretamente à proposta, por exemplo, com `Linha da planilha: 3`, depois de conferir o equipamento na base. O bot valida a embarcação e a identificação existente, reapresenta todos os dados e aguarda `confirmo`. A indicação da linha, por si só, não grava os dados.

- **Registros:** [Mr Alinhamento](https://docs.google.com/spreadsheets/d/1oc2u-thAhflrqEb3m6hxux8Yg6jEE6wGY-zFQyBRR38/edit), aba `Modelo alinhamento`; definir o ID em `SPREADSHEET_ID`.
- **Referências:** [Configuração - alinhamento](https://docs.google.com/spreadsheets/d/1KroIP08qi3FfpG5JO_aJgl8OHXcZvwBpEP2dL6ZCDKM/edit), abas `Taxonomia`, `Glossario`, `Configurações` e `Masterlist`; definir o ID em `CONFIG_SPREADSHEET_ID`.
- A conta de serviço precisa de leitura na planilha de referências e edição na planilha de registros. Na VM, o Google Sheets usa Application Default Credentials da conta anexada; não use chaves privadas no repositório.
- `GEMINI_API_KEY` deve vir do ambiente ou do gerenciador de segredos. Nunca registre a chave nos logs.

Os cabeçalhos ocupam as linhas 1 e 2 e incluem grupos de colunas. O mapeamento considera o título e o grupo, inclusive para `Maker`, `Model` e `Equipment Class` repetidos. `Comments` guarda observações, identificadores de sessão e de confirmação, e o horário de inclusão de linhas novas.

## Configuração

Variáveis obrigatórias:

```env
SPREADSHEET_ID=ID_DA_PLANILHA_DE_REGISTROS
CONFIG_SPREADSHEET_ID=ID_DA_PLANILHA_DE_REFERENCIAS
GEMINI_CONVERSATION_ENABLED=true
GEMINI_API_KEY=CHAVE_FORNECIDA_PELO_AMBIENTE
GEMINI_MODEL=gemini-3.1-flash-lite
```

Execute `npm install` e depois `npm start`. O serviço de produção é gerenciado por systemd na VM `alinhamento-bot`.

## Privacidade e operação

IDs processados, sessões, propostas e pendências ficam em arquivos locais privados. `alignment-sessions.json`, `alignment-confirmations.json` e `pending-alignment.jsonl` podem conter conteúdo operacional; mantenha-os fora do Git e com acesso restrito. O bot envia mensagens somente depois de ser mencionado: primeiro pede a validação e, em seguida, informa o resultado da gravação.

## Verificação

Rode `npm test` para verificar a confirmação completa, o destino da gravação, a ativação por menção e a espera de duas horas para incluir outro equipamento. Use um grupo de teste e dados fictícios para conferir a operação no WhatsApp e no Google Sheets.
