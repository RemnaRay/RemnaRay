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

## The operators' chat

Create a Telegram group for the operators, add the shop's bot and set the
group's id (`-100…`) in «Настройки» → «brand» → `support_forward_chat_id`.

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
