#!/bin/sh
# The panel worker owns downloading, validation, live reload and rollback.
set -eu
directory=/opt/etc/xkeen-ui
mkdir -p "$directory"
case "${1:-status}" in
    update)
        pidof xkeen-ui >/dev/null || { echo 'Запустите панель перед обновлением баз'; exit 1; }
        touch "$directory/geodata.refresh"
        echo 'Проверка баз запрошена; панель выполнит её в течение минуты'
        ;;
    interval)
        hours=${2:-}
        case "$hours" in ''|*[!0-9]*) echo 'Укажите интервал 1–720 часов, либо 0 для отключения'; exit 1 ;; esac
        [ "$hours" -le 720 ] || { echo 'Максимальный интервал — 720 часов'; exit 1; }
        umask 077
        printf '{"intervalHours":%s}\n' "$hours" > "$directory/geodata.json.new"
        mv "$directory/geodata.json.new" "$directory/geodata.json"
        echo "Интервал проверки: $hours ч (0 — автоматическая проверка отключена)"
        ;;
    status)
        [ -f "$directory/geodata.json" ] || echo '{"intervalHours":12}'
        [ ! -f "$directory/geodata.json" ] || cat "$directory/geodata.json"
        [ ! -f "$directory/geodata-state.json" ] || cat "$directory/geodata-state.json"
        echo
        ;;
    *) echo 'Использование: xkeen-geodata update | interval ЧАСЫ | status'; exit 1 ;;
esac
