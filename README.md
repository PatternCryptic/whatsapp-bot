# Coletor de alinhamentos

Bot de WhatsApp que acompanha grupos continuamente, reconhece conversas sobre alinhamento por contexto e registra informações comprovadas na planilha `Mr Alinhamento`. Após registrar, o bot envia uma confirmação ao grupo.

## Funcionamento

- As conversas são mantidas separadas por grupo e ficam abertas para resultados que cheguem horas depois.
- O Gemini considera o texto, o título do grupo, a taxonomia, o glossário e as combinações de máquinas da planilha de configuração.
- Anexos JPEG, PNG, WebP e PDF são baixados em memória e enviados ao Gemini para leitura. O Gemini lista cada equipamento distinto no documento e organiza os fatos por equipamento, com referência ao trecho ou à figura e página. Anexos acima de 20 MB ou em formatos não suportados são sinalizados para revisão. O conteúdo binário não é salvo na sessão; a extração textual é.
- Se a leitura de um anexo falhar ou vier vazia, o arquivo é preservado em `failed-attachments/` com acesso restrito e a ocorrência é registrada em `pending-alignment.jsonl`. Acompanhe essas pendências para recuperar o documento; o bot registra nos logs apenas metadados do anexo e o tamanho do resumo, sem expor seu conteúdo.
- PDFs com vários geradores recebem uma segunda leitura focada no GAP final de cada conjunto, com trecho e página do relatório. Folga do virabrequim, pré GAP e valores anteriores ao alinhamento não entram na coluna `Coupling GAP`.
- Quando o relatório informa um intervalo geral que cobre o serviço, a coluna `Data` recebe o período completo. O bot não transforma esse intervalo em uma data específica para cada equipamento.
- A cada cinco minutos, o Gemini compara as mensagens e relatórios da sessão com os cabeçalhos da aba `Modelo alinhamento` e sincroniza uma linha **por equipamento**. Um relatório com DG #1, #2, #3 e #4 resulta em quatro linhas. A primeira gravação preenche campos ausentes com `não informado`; sincronizações seguintes completam células ainda desconhecidas na mesma linha.
- Após gravar, o bot envia ao grupo um resumo por equipamento e pede confirmação. Divergências entre legenda e imagem são informadas para esclarecimento. Responda diretamente à mensagem do bot com o campo e valor (por exemplo `axial vertical: -0,01 mm`); quando houver uma única divergência, um número isolado também é aceito. Uma resposta inequívoca atualiza a célula da mesma sessão.\n- O estado das confirmações fica em `alignment-confirmations.json`, protegido e fora do Git. Falhas de envio são registradas em `pending-alignment.jsonl` para revisão, sem reenvio automático que possa duplicar a mensagem.\n- Sessões sem mensagens novas não são reprocessadas a cada ciclo; falhas transitórias são tentadas novamente no próximo ciclo.
- Novos equipamentos iniciam uma atividade separada quando o Gemini consegue distingui-los. Complementações de um relatório com vários equipamentos permanecem na sessão. Se um dado posterior entrar em conflito com um valor já registrado, a linha preserva o valor comprovado, preenche outros campos ainda desconhecidos e sinaliza o conflito para revisão.
- Tolerâncias e medições são extraídas separadamente. O código não calcula valores nem conclui aceitabilidade sem dados compatíveis.
- Quando embarcação ou equipamento não podem ser associados com segurança, o bot ainda registra os demais dados com `não informado` na identidade ausente e cria uma pendência em `pending-alignment.jsonl` para esclarecimento. 

## Planilhas e permissões

- **Registros:** [Mr Alinhamento](https://docs.google.com/spreadsheets/d/1oc2u-thAhflrqEb3m6hxux8Yg6jEE6wGY-zFQyBRR38/edit), aba `Modelo alinhamento`; definir o ID em `SPREADSHEET_ID`.
- **Referências:** [Configuração - alinhamento](https://docs.google.com/spreadsheets/d/1KroIP08qi3FfpG5JO_aJgl8OHXcZvwBpEP2dL6ZCDKM/edit), abas `Taxonomia`, `Glossario`, `Configurações` e `Masterlist`; definir o ID em `CONFIG_SPREADSHEET_ID`.
- A conta de serviço do bot precisa de leitura na planilha de referências e edição na planilha de registros. Na VM, o Google Sheets usa Application Default Credentials da conta anexada; não use chaves privadas no repositório.
- `GEMINI_API_KEY` deve vir do ambiente ou do gerenciador de segredos. Nunca registre a chave nos logs.

Os cabeçalhos ocupam as linhas 1 e 2 e incluem grupos de colunas. O mapeamento é por título e grupo, inclusive para `Maker`, `Model` e `Equipment Class` repetidos. `Comments` contém um identificador da sessão e do equipamento, usado para atualizar a mesma linha sem duplicá-la.

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

Para recuperar um PDF preservado após uma falha de leitura, pare temporariamente o serviço, execute `node index.js --recover-attachment failed-attachments/NOME.pdf` no diretório do bot e reinicie o serviço. A recuperação usa o registro da pendência para localizar o grupo, reinterpreta o anexo, sincroniza as linhas e salva o resumo na sessão. Se a extração continuar parcial, mantém o arquivo para revisão. Não envie o arquivo nem chaves para o repositório.

## Privacidade e operação

A lista de IDs processados e as sessões ficam em arquivos locais privados. `alignment-sessions.json` e `pending-alignment.jsonl` podem conter conteúdo operacional; mantenha-os fora do Git e com acesso restrito. O bot envia resumos de confirmação e solicita esclarecimento no grupo após registrar os dados.

## Verificação

Rode `npm test` para verificar o mapeamento dos cabeçalhos, o preenchimento de desconhecidos, o isolamento das conversas e a separação de vários equipamentos em um relatório. Para testar a leitura, use um grupo de teste e um PDF ou imagem com dados fictícios. Confira uma linha por equipamento, depois envie uma complementação fictícia e confirme que só células `não informado` são preenchidas. Não use dados falsos na planilha operacional.
