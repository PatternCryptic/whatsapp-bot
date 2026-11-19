# Publicação e revisão no GitHub

O repositório existente usa a branch padrão `master`. Faça atualizações em uma branch e abra um pull request para revisão antes de integrar.

## Conteúdo que não deve ser enviado

Não versione `credentials.json`, chaves de contas de serviço, `.env`, `auth_info_baileys/`, dados de sessões ou conversas, `node_modules/` nem arquivos de estado operacional. O `.gitignore` do projeto cobre esses itens; confira `git status` antes de publicar.

O bot em produção usa ADC da conta de serviço anexada à VM. Para segredos de runtime, use o Secret Manager ou a configuração protegida do serviço. Não crie um secret `GOOGLE_CREDENTIALS` com uma chave privada de conta de serviço.

## Atualização

1. Crie uma branch a partir de `master`.
2. Revise o diff e confirme que não há segredos nem estado local.
3. Abra um pull request com resumo funcional e evidências de verificação disponíveis.
4. Integre após revisão e atualize a VM conforme o procedimento operacional documentado no `README.md`.

O deploy em produção deve usar a identidade e o procedimento já configurados no projeto do Google Cloud; este guia não presume um nome de instância, zona ou credencial local.
