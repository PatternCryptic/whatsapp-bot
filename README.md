# Coletor de alinhamentos

Bot de WhatsApp que só inicia a análise quando alguém menciona o bot em um grupo. O Gemini interpreta mensagens, relatórios e imagens, compara os dados com os cabeçalhos da planilha e pede validação antes de gravar.

## Funcionamento

- Antes da menção, o bot mantém em memória uma janela das mensagens recentes para usar como contexto quando for chamado. Depois da menção, acompanha aquele grupo por até duas horas. As sessões são isoladas por grupo e equipamento.
- O Gemini considera o texto, o título do grupo, a taxonomia, o glossário e as combinações de máquinas da planilha de configuração.
- Anexos JPEG, PNG, WebP e PDF são enviados ao Gemini para leitura. Relatórios com vários equipamentos geram uma proposta para cada equipamento. Anexos acima de 20 MB ou em formatos não suportados ficam pendentes para revisão.
- PDFs com vários geradores recebem uma segunda leitura focada no GAP final de cada conjunto. Folga do virabrequim, pré-GAP e valores anteriores ao alinhamento não entram na coluna `Coupling GAP`.
- A cada cinco minutos, o Gemini compara as mensagens e os anexos com os cabeçalhos reais da aba `Modelo alinhamento`. Cada campo ausente aparece como `não informado`; a ausência de dados não impede a proposta.
- O bot apresenta os valores interpretados e aguarda uma resposta. Nenhuma linha é gravada antes da validação. Responda à mensagem do bot com `confirmo` ou corrija os campos no formato `Axial Vertical: -0,01 mm`.
- Uma correção explícita valida os dados apresentados e é gravada. Se a pessoa confirmar uma divergência entre legenda e imagem sem corrigi-la, a célula recebe `usuário passou informação divergente`; os outros campos validados são gravados normalmente.
- Se embarcação ou equipamento ainda estiverem como `não informado`, o bot pede esses dados e não grava até poder identificar o registro com segurança.
- Durante duas horas, uma confirmação para a mesma embarcação e equipamento atualiza a linha recente, sem criar outra. Se houver mais de uma linha possível, o bot não escolhe automaticamente e deixa o caso pendente para revisão.
- Tolerâncias e medições são extraídas separadamente. O código não calcula valores nem conclui aceitabilidade sem dados compatíveis.

## Planilhas e permissões

- **Registros:** [Mr Alinhamento](https://docs.google.com/spreadsheets/d/1oc2u-thAhflrqEb3m6hxux8Yg6jEE6wGY-zFQyBRR38/edit), aba `Modelo alinhamento`; definir o ID em `SPREADSHEET_ID`.
- **Referências:** [Configuração - alinhamento](https://docs.google.com/spreadsheets/d/1KroIP08qi3FfpG5JO_aJgl8OHXcZvwBpEP2dL6ZCDKM/edit), abas `Taxonomia`, `Glossario`, `Configurações` e `Masterlist`; definir o ID em `CONFIG_SPREADSHEET_ID`.
- A conta de serviço precisa de leitura na planilha de referências e edição na planilha de registros. Na VM, o Google Sheets usa Application Default Credentials da conta anexada; não use chaves privadas no repositório.
- `GEMINI_API_KEY` deve vir do ambiente ou do gerenciador de segredos. Nunca registre a chave nos logs.

Os cabeçalhos ocupam as linhas 1 e 2 e incluem grupos de colunas. O mapeamento considera o título e o grupo, inclusive para `Maker`, `Model` e `Equipment Class` repetidos. `Comments` contém identificadores de sessão e horário de gravação para manter a identidade da linha e aplicar a janela de duas horas.

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

Rode `npm test` para verificar o mapeamento dos cabeçalhos, o preenchimento de desconhecidos, a ativação por menção, as propostas sem gravação prévia, o isolamento das conversas e a trava de duas horas para duplicidade. Use um grupo de teste e um PDF ou imagem com dados fictícios para conferir a leitura e a confirmação antes de testar na planilha operacional.
