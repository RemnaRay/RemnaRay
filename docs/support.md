# Customer support in the bot

«Поддержка» in the bot (FR-124) shows `brand.support_contact` (a `@username`
or a URL). When `brand.support_forward_chat_id` names the operators' chat, it
also opens a conversation with the operators (after «Написать оператору» when
there are self-help questions): everything the customer writes
to the bot — text, photos, files, voice and video messages, stickers — goes to
the operators until the customer presses «Завершить» (or a day passes without
a message either way). An operator's answer comes back to the customer in the
bot and keeps the conversation open, so the customer answers by simply writing.
Commands and the bot's own buttons keep working meanwhile.

Messages are copied (`copyMessage`), not re-typed: an operator sees the
customer's photo or file as it was sent, and the customer sees the operator's.
Text answers arrive under «Ответ поддержки» in the customer's language, with
«Завершить» beneath.

## Self-help first (owner decision F36)

The owner can add **self-help questions** in the console («Поддержка» →
«FAQ»; question and answer in ru and en, an order, on/off). When there are
any, «Поддержка» in the shop bot shows them as buttons with «Написать
оператору», which opens the conversation; without them it opens at once, as
before. The support bot's `/start` shows the questions, «Моя ссылка
подписки» (the customer's own link, or a note that there is none) and
«Написать оператору»; there anything the customer writes opens a ticket
anyway. An answer is shown as written (plain text), in the customer's
language or, when that one is empty, the other.

## Tickets (owner decision F36)

Every request is a numbered **ticket**; a customer's history stays in one
topic, a ticket at a time. When a customer with no open ticket writes, a ticket
opens: the customer gets «Обращение #N создано», and the operators get
`🎫 Открыт тикет #N` and the customer's **card** in their topic. The card shows:

- the ticket: number, status, who works on it, when it opened (and closed);
- the customer: name, @username, Telegram id, language, registration, last
  visit, who invited them, banned / blocked the bot / trial used;
- the subscription: status, plan, end date, traffic used of the limit, device
  limit, the subscription link;
- money: balance, the last purchase, everything paid through providers (the
  dashboard's rule), unpaid invoices;
- support: how many requests so far, the previous one's date and rating, the
  administrator's note.

Its buttons: **«Взять в работу»** (the customer is told an operator joined),
**«Закрыть»** (the customer is told the request is closed), **«Закрыть тихо»**
(the customer is told nothing), **«Обновить»** and **«В консоли»** (the user's
page in the console). Any member of the operators' chat may use them; the
buttons work only in that chat. The first answer takes a ticket nobody took.
In the topic, `/close`, `/silent` and `/card` do the same as the buttons. An
operator writing to a customer without an open ticket opens one.

**Actions on the customer.** A live ticket's card also has «+7 дней», «+30
дней», «Сбросить трафик» and «Отправить ссылку»; in the topic `/extend <days>
[reason]` and `/credit <amount ₽> [reason]` do the same for any number of days
or a credit to the balance (`150`, `150,50`). Unlike take and close, these are
only for a **console administrator** whose Telegram ID is set in
«Администраторы», with their role's rights (section 14.2: an operator may
credit up to `operator.max_credit_minor` a day and never debit). They run the
console's own code, write the same audit row (reason `support #N[: reason]`,
user agent `telegram:support`) and leave a line in the topic; the link goes to
the customer from the support bot. A card button runs once a minute per ticket (a double tap, or two
administrators pressing it), and a command message runs once even if Telegram delivers it twice.

**Reminders and auto-close.** The worker sweeps the tickets every minute
(`maintenance.support-sweep`). A ticket nobody took for
`support.remind_after_minutes` (15 by default) is announced once in the
operators' chat — `⏰ Тикет #N ждёт ответа … мин` with a link to its topic. A
ticket whose last word was the operators' and that the customer has not
answered for `support.autoclose_hours` (48 by default) closes by itself: the
customer is told and asked for a rating, the topic gets `💤 Тикет #N закрыт
автоматически`. Either setting at 0 turns its part off; both are in
«Настройки» (group `support`).

**Rating.** A closed ticket's notice asks the customer to rate the help
(★1–★5); only the first rating of their own closed ticket counts. The rating
appears in the topic (`★★★★☆ Оценка тикета #N: 4`) and on the card. A silent
close asks nothing.

**Statistics.** `GET /api/admin/v1/support/stats?from&to` (the last 30 days
by default; `support.read`): tickets opened and closed, open now, the time to
the first answer (average and median), the time to the close, the average
rating, and the same per operator who took tickets.

**In the console.** «Поддержка» (`support.read`: administrators and
operators) lists the tickets — not closed, new, in work, closed or all;
search by `#number`, Telegram id or `@username` — and opens a ticket's history
(text and captions; attachments by their kind; notes; the bot's lines).
«Статистика» shows the period's numbers, «Шаблоны» and «FAQ» are edited with
`support.write` (administrators). A user's page links to their requests.

**Notes and templates.** A message starting with `//` is an internal note:
it is kept with the ticket and never sent to the customer. `/t` lists the
answer templates, `/t <code>` sends one to the customer in their language
(the other language when theirs is empty); the owner edits them in the
console (`support.write`, «Поддержка» → «Шаблоны»; `GET|POST
/api/admin/v1/support/templates`, `PUT|DELETE …/templates/:id`).

In a forum the topic's name shows the ticket's status — 🟢 new, 🟡 in work,
⚪ closed (`editForumTopic`, the same «Управление темами» right).

After a close the customer's next message opens the next ticket. In the shop
bot «Завершить» closes the ticket from the customer's side (the operators see
«Пользователь закрыл тикет #N»); in the support bot the confirmation of a new
ticket carries «Закрыть обращение».

Tickets and their messages (text or caption, the kind and Telegram's
`file_id` of an attachment, who wrote it) are kept in the database
(`support_tickets`, `support_messages`, `support_topics`); anonymising a user
clears what they wrote. Topics opened before tickets (kept in Valkey) are
carried over on first use.

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
  own, named after them with their Telegram id and the ticket's status, where
  every ticket opens with the card. Everything an operator writes in that topic goes
  to the customer. The bot must be an administrator with the «Управление темами»
  right; bot administrators receive every message of the group, which is how
  the answers reach it. Without the right, messages arrive in the general topic
  and the administrators get a `support.topics` alert.
- **A plain group**: a ticket opens with `🎫 Открыт тикет #N` and the card,
  each message arrives as a copy replying to the card, and the operator
  answers with Telegram's «Ответить» on any of them. The bot sees such replies
  even in privacy mode.

If the customer blocked the bot, the operator gets «Не доставлено покупателю»
in reply. A customer whose message could not be delivered to the operators is
told so instead of «передано».

Whether a customer is writing to support in the shop bot is kept in Valkey
(`rr:support:open:<id>`); tickets, messages and topics are in the database.
