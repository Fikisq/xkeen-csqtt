# RU-маршрутизация: исследование и предлагаемая схема

Дата: 13 октября 2026. По просьбе пользователя изменения маршрутизации не применялись.

## Как устроено у других клиентов

| Клиент | Механизм | Что полезно для нашей панели |
| --- | --- | --- |
| Podkop | Секции sing-box, выбранные списки доменов/подсетей, Exclusion для direct; DNS/FakeIP связывает домен с соединением | Явно выбирать назначение каждого списка, не считать название региона готовой политикой |
| Forkop | Секции и действия route/bypass/block/zapret2; отдельные rule sets, DNS и resolver | Сохранить разделение полного обхода устройства и исключений отдельных ресурсов |
| PassWall2 | Shunt-правила Xray/sing-box с отдельными списками доменов/IP и выбранным выходом; настраиваемые AsIs/IPIfNonMatch/IPOnDemand | Контролировать порядок правил и не превращать произвольный IP-список в признак национальности сайта |
| OpenClash | Упорядоченные правила DOMAIN/GEOSITE/RULE-SET/IP, финальное правило; FakeIP-фильтры настраиваются отдельно | Сначала сервисные исключения, затем доменные списки, затем явно выбранный fallback |

Podkop и Forkop используют списки itdoginfo/allow-domains. `Russia inside` содержит ресурсы, блокируемые из РФ; `Russia outside` — российские сервисы, для которых нужен российский IP. Второй список не является полным списком RU-интернета. Например, он включает зависимости Почты и Ozon на доменах CDN, а также `showip.net` — готовые списки всё равно требуют проверки назначения.

FakeIP — часть DNS-архитектуры Podkop/Forkop. Нельзя получить тот же результат простым копированием `.srs` в Xray; нужен соответствующий DNS-перехват, обработка клиентских DoH/DoT и преобразование формата базы. Установка sing-box или изменение DNS сейчас не выполнялись.

## Что обнаружено в нашей схеме

- RU-строка панели объединяет два настоящих правила Xray: домены RoscomVPN `category-ru`/`whitelist` **ИЛИ** адреса GeoIP `direct`. Это сознательное объединение, а не условие «домен и IP одновременно».
- У перенаправленных соединений `routeOnly` сохраняет настоящий IP назначения, добавляя обнаруженный домен для выбора маршрута. В Xray 26.9.9 `GetTargetIPs()` читает настоящий Target, а `GetTargetDomain()` — RouteTarget. Поэтому IP-ветка может совпасть и у соединения с известным зарубежным доменом.
- Название категории `direct` не означает «только российские сайты». Общая подсеть/CDN может обслуживать несколько сервисов; совпадение адреса недостаточно для решения о конкретном домене.
- В установленной RoscomVPN GeoSite `api.ipify.org` входит одновременно в `CATEGORY-RU` и `WHITELIST`. Запрос к этому сервису проверки IP может уйти напрямую независимо от выбора туннеля. `www.speedtest.net`, `ookla.com`, `google.com`, `ipinfo.io` в этих категориях не найдены; утверждать, что весь Speedtest всегда direct, нельзя. Его сервер замера может соединяться по IP.
- `yandex.ru` и `dzen.ru` входят в `WHITELIST`; GitHub — в собственную категорию `GITHUB`. Эти наблюдения относятся к установленным базам на дату исследования.

## Предлагаемая схема для устройств с VPN

1. Сохранить локальные сети и явный полный обход рабочих устройств на прежних местах.
2. Выше RU поставить индивидуальные сервисные правила: AI, YouTube и другие выбранные пользователем ресурсы.
3. Проверки внешнего IP/скорости направлять через выбранный туннель отдельным правилом, чтобы список direct не искажал замер. Для IP-only сервера Speedtest одного доменного правила недостаточно.
4. Российские сервисы направлять напрямую по выбранным доменным спискам. RoscomVPN остаётся доступным; список Podkop `Russia outside` можно предложить как дополнительный источник для сервисов с RU-геоблокировкой, не как замену всем RU-ресурсам.
5. Широкий GeoIP-DIRECT сделать отдельной опцией, выключенной в строгом режиме. Если её оставлять, сначала должен сработать доменный fallback для всех остальных известных доменов; это защищает домены на общих IP, но не неизвестные IP-only соединения.
6. В строгом режиме неизвестный домен или голый публичный IP направлять по маршруту по умолчанию — в выбранный туннель. Для рабочей системы на IP добавлять конкретное исключение или полный обход устройства, а не открывать весь GeoIP-DIRECT.

Это уменьшает ошибочный direct, но полноту RU-списка не гарантирует. Недостающие зависимости сайта следует добавлять по журналу/диагностике, не переносить целый CDN или ASN в direct.

## Источники

- [Podkop: секции](https://podkop.net/docs/sections/), [DNS](https://podkop.net/docs/dns/), [constants.sh](https://github.com/itdoginfo/podkop/blob/da8bd40/podkop/files/usr/lib/constants.sh).
- [Forkop: README](https://github.com/ushan0v/forkop), [источники rule sets](https://github.com/ushan0v/forkop/blob/dd48329/forkop/files/usr/lib/singbox/rulesets.uc), [генерация route](https://github.com/ushan0v/forkop/blob/dd48329/forkop/files/usr/lib/singbox/route.uc).
- [Описание списков itdoginfo](https://github.com/itdoginfo/allow-domains), [Russia outside](https://github.com/itdoginfo/allow-domains/blob/9b6d367/src/Russia-domains-outside.lst).
- [PassWall2: настройки Xray shunt](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/492309e/luci-app-passwall2/luasrc/model/cbi/passwall2/client/include/shunt_options.lua).
- [OpenClash: шаблон конфигурации](https://github.com/vernesong/OpenClash/blob/master/luci-app-openclash/root/usr/share/openclash/res/default.yaml).
- [Xray 26.9.9: routing context](https://github.com/XTLS/Xray-core/blob/v26.9.9/features/routing/session/context.go).
- [RoscomVPN GeoSite](https://github.com/hydraponique/roscomvpn-geosite), [GeoIP](https://github.com/hydraponique/roscomvpn-geoip).
