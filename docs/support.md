# Customer support in the bot

«Поддержка» in the bot (FR-124) shows `brand.support_contact` (a `@username`
or a URL). When `brand.support_forward_chat_id` names the operators' chat, it
also opens a conversation with the operators: everything the customer writes
to the bot — text, photos, files, voice and video messages, stickers — goes to
the operators until the customer presses «Завершить» (or a day passes without
a message either way). An operator's answer comes back to the customer in the
bot and keeps the conversation open, so the customer answers by simply writing.
Commands and the bot's own buttons keep working meanwhile.

Messages are copied (`copyMessage`), not re-typed: an operator sees the
customer's photo or file as it was sent, and the customer sees the operator's.
Text answers arrive under «Ответ поддержки» in the customer's language, with
«Завершить» beneath.

## A support bot of its own (optional)

Support can run in a separate Telegram bot (owner decision F35): create one
with @BotFather and give its token in the setup wizard's «Бот» step or later in
«Настройки» → «Поддержка» (the console checks it with `getMe` and refuses the
shop bot's own token; «Отключить бот поддержки» turns it off). Then:

- «Поддержка» in the shop bot shows a link to the support bot instead of
  opening a conversation;
- a customer writes to the support bot, and every message — text, photos,
  files, voice — goes to their topic in the operators' chat; `/start` greets
  them in their Telegram language;
- the operators' answers come back from the support bot, copied as they are;
- the **support bot** must be the administrator of the operators' chat with
  «Управление темами»; the shop bot can stay in the chat, it stays silent there.

The bot process runs it beside the shop bot in the same delivery mode
(`bot.mode`): with a webhook it has its own secret path under `/tg/webhook/` and
its own secret token (`bot.support_webhook_secret_*`), and its updates wait in
the Valkey stream `tg:support-updates:<bot id>`. Removing its token, or giving
another bot's, removes the old bot's webhook, drops its secrets and deletes its
stream, so nothing the old bot was sent reaches the new one; a reissued token
of the same bot keeps them. A support bot that cannot start (a revoked token)
is retried with a growing pause, up to five minutes, while the shop bot keeps
running.

## The operators' chat

Create a Telegram group for the operators, add the shop's bot (or the support
bot) and set the group's id (`-100…`) in the wizard's «Бот» step or in
«Настройки» → «Поддержка».

- **A forum supergroup** (topics enabled) gives every customer a topic of their
  own, named after them with their Telegram id, opened by a card with their id,
  username, name and language. Everything an operator writes in that topic goes
  to the customer. The bot must be an administrator with the «Управление темами»
  right; bot administrators receive every message of the group, which is how
  the answers reach it. Without the right, messages arrive in the general topic
  and the administrators get a `support.topics` alert.
- **A plain group**: each message arrives as a copy replying to a
  `#support <id> @username` card, and the operator answers with Telegram's
  «Ответить» on either. The bot sees such replies even in privacy mode. An
  answer works for 30 days after the question.

If the customer blocked the bot, the operator gets «Не доставлено покупателю»
in reply. A customer whose message could not be delivered to the operators is
told so instead of «передано».

The links between topics, messages and customers, and whether a customer's
conversation is open, are kept in Valkey (`rr:support:*`).
