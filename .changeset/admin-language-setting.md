---
'@remnaray/api': patch
'@remnaray/web': patch
---

The console now speaks `admin.language` from Settings. It followed the site's default locale instead, so changing the console language did nothing; the public config carries it as `locales.admin`. A shop whose site default changed after setup keeps the console in the language the wizard chose until `admin.language` is changed too.
