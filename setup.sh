#!/bin/sh

GREEN=$'\033[32m'
GREEN_BOLD=$'\033[1;32m'
RED=$'\033[31m'
RED_BOLD=$'\033[1;31m'
NC=$'\033[0m'
NCN="$NC\n\n"
BLUE=$'\033[1;34m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[1;96m'

ERROR="\n${RED} ❌${RED_BOLD}"
SUCCESS="\n${GREEN} ✅${GREEN_BOLD}"
INFO="\n${CYAN} ℹ️ "

XKEENUI_BIN="/opt/sbin/xkeen-ui"
XKEENUI_INIT="/opt/etc/init.d/S99xkeen-ui"
STATIC_DIR="/opt/share/www/XKeen-UI"
LIGHTTPD_INIT="/opt/etc/init.d/S80lighttpd"
LIGHTTPD_DIR="/opt/etc/lighttpd"
LIGHTTPD_CONF="$LIGHTTPD_DIR/conf.d/90-xkeenui.conf"

BETA=false
AUTO=false
for setup_arg in "$@"; do
  case "$setup_arg" in beta) BETA=true ;; auto) AUTO=true ;; esac
done
LOCAL=false
BIN_STAGED=
SUM_FILE=
NFQWS_STAGED=
NFQWS_STAGED_OWNED=false
NFQWS_ROOT="/opt/etc/xkeen/nfqws2-stage"
BOOTSTRAP_STAGED=
FRESH_CORE=false
FIRST_PANEL=false
CORE_API_RESTART=false
CORE_API_BACKUP=
cleanup_download() {
  [ -z "$BIN_STAGED" ] || rm -f "$BIN_STAGED"
  [ -z "$SUM_FILE" ] || rm -f "$SUM_FILE"
  [ "$NFQWS_STAGED_OWNED" != true ] || rm -f "$NFQWS_STAGED"
  [ -z "$BOOTSTRAP_STAGED" ] || rm -f "$BOOTSTRAP_STAGED"
}
trap cleanup_download EXIT

prepare_entware() {
  export PATH=/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin
  [ "$(id -u)" = 0 ] || { echo 'Запустите установщик от root.' >&2; exit 1; }
  [ -x /opt/bin/opkg ] && [ -f /opt/etc/init.d/rc.func ] || {
    echo 'Сначала включите Entware в KeeneticOS и подключитесь к его SSH. После этого повторите эту команду.' >&2
    exit 1
  }
  mkdir -p /opt/tmp /opt/sbin /opt/etc/init.d
  if ! command -v curl >/dev/null || ! command -v jq >/dev/null || ! command -v sha256sum >/dev/null; then
    opkg update && opkg install curl jq coreutils-sha256sum ca-bundle || exit 1
  fi
}

check_existing_core() {
  if [ -f /opt/etc/init.d/S05xkeen ]; then
    local active_client
    active_client=$(sed -n 's/^name_client=//p' /opt/etc/init.d/S05xkeen | head -n 1 | tr -d "\"'[:space:]")
    case "$active_client" in
      xray) ;;
      mihomo)
        [ -x /opt/sbin/mihomo ] && [ -s /opt/etc/mihomo/config.yaml ] || {
          echo 'Неполная установка Mihomo; восстановите ядро и config.yaml.' >&2; exit 1;
        } ;;
      *) echo 'Неизвестное активное ядро XKeen.' >&2; exit 1 ;;
    esac
    if [ ! -x /opt/sbin/xray ] || [ ! -f /opt/etc/xray/configs/00_config.json ] || ! grep -q device_capture_xray /opt/etc/init.d/S05xkeen; then
      echo 'Обнаружена старая установка XKeen с другой структурой конфигурации или скриптом запуска.' >&2
      echo 'Не удаляйте её: необходим перенос конфигурации с резервной копией. Установка остановлена, действующие маршруты сохранены.' >&2
      exit 1
    fi
  elif [ -e /opt/sbin/xkeen ] || [ -e /opt/sbin/xray ] || [ -e /opt/etc/init.d/S99xkeen ]; then
    echo 'Обнаружена другая или неполная установка XKeen. Она не будет удалена или перезаписана автоматически; нужен перенос настроек с резервной копией.' >&2
    exit 1
  fi
}

prepare_core() {
  check_existing_core
  if [ -x /opt/sbin/xray ] && [ -x /opt/etc/init.d/S05xkeen ]; then
    printf '\n Существующие Xray и XKeen сохранены.\n'
    return 0
  fi
  # Do not silently replace an unrelated/partial existing installation.
  if [ -e /opt/sbin/xkeen ] || [ -e /opt/sbin/xray ] || [ -e /opt/etc/init.d/S05xkeen ]; then
    echo 'Обнаружена неполная установка XKeen/Xray. Автоматическая перезапись остановлена; существующие настройки сохранены.' >&2
    exit 1
  fi
  for fragment in /opt/etc/xray/configs/*.json; do
    [ ! -f "$fragment" ] || {
      echo 'Найдены настройки Xray без установленного ядра. Автоматическая перезапись остановлена; сохраните и восстановите установку.' >&2
      exit 1
    }
  done
  [ -n "$BOOTSTRAP_STAGED" ] || { echo 'В релизе отсутствует комплект первоначальной настройки.' >&2; exit 1; }
  local work actual
  work=$(mktemp -d /opt/tmp/xkeen-core.XXXXXX) || exit 1
  printf '\n Установка XKeen и Xray без дополнительных вопросов...\n'
  curl -fLsS --retry 2 https://github.com/jameszeroX/XKeen/releases/download/2.1/xkeen.tar.gz -o "$work/xkeen.tar.gz" || exit 1
  actual=$(sha256sum "$work/xkeen.tar.gz" | awk '{print $1}')
  [ "$actual" = 4b9350b11fab7fd3e4973db609db0fb780994f4b5ab0096f0549bc52acac8c73 ] || {
    echo 'Контрольная сумма XKeen не совпадает.' >&2; exit 1
  }
  mkdir "$work/core" "$work/panel"
  tar -xzf "$work/xkeen.tar.gz" -C "$work/core" || exit 1
  tar -xzf "$BOOTSTRAP_STAGED" -C "$work/panel" || exit 1
  [ -f "$work/core/xkeen" ] && [ -d "$work/core/_xkeen" ] &&
    [ -s "$work/panel/S05xkeen" ] && [ -s "$work/panel/00_config.json" ] || exit 1
  # Install the same pinned modules as the official installer, then use its
  # documented unattended mode. No Mihomo or competing geodata cron jobs.
  mv "$work/core/xkeen" /opt/sbin/xkeen && mv "$work/core/_xkeen" /opt/sbin/.xkeen || exit 1
  chmod 755 /opt/sbin/xkeen
  XKEEN_FOREGROUND=1 /opt/sbin/xkeen -i auto cores=xray xray=v26.9.9 geo=off geoipset=off cron=off autostart=off || exit 1
  [ -x /opt/sbin/xray ] && [ -f /opt/etc/init.d/S05xkeen ] || {
    echo 'Установка Xray/XKeen не завершилась.' >&2; exit 1
  }
  # Only newly generated upstream fragments are moved; an existing core took
  # the early return above. Keep them available for diagnosis or rollback.
  local initial_backup="/opt/etc/xkeen/initial-configs-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$initial_backup" /opt/etc/xray/configs /opt/var/log/xray
  for fragment in /opt/etc/xray/configs/*.json; do
    [ ! -f "$fragment" ] || mv "$fragment" "$initial_backup/" || exit 1
  done
  cp "$work/panel/00_config.json" /opt/etc/xray/configs/00_config.json || exit 1
  # Seed the inactive core only when it has no configuration. Installing the
  # panel must not import this router owner's routes or select another core.
  if [ ! -e /opt/etc/mihomo/config.yaml ] && [ -s "$work/panel/mihomo-config.yaml" ]; then
    mkdir -p /opt/etc/mihomo || exit 1
    (umask 077; cp "$work/panel/mihomo-config.yaml" /opt/etc/mihomo/config.yaml) || exit 1
  fi
  cp "$work/panel/S05xkeen" /opt/etc/init.d/S05xkeen || exit 1
  # Also repair older bootstrap bundles downloaded by a newer setup.sh.
  # Subscription nodes must be addable through the local API on first launch.
  jq '.api.services = (((.api.services // []) + ["HandlerService", "RoutingService"]) | unique)' \
    /opt/etc/xray/configs/00_config.json > "$work/00_config.api.json" || exit 1
  cp "$work/00_config.api.json" /opt/etc/xray/configs/00_config.json || exit 1
  if [ ! -r /opt/sbin/.xkeen/01_info/03_info_router.sh ]; then
    [ -r /opt/sbin/.xkeen/01_info/08_info_router.sh ] || {
      echo 'В установленном XKeen отсутствует модуль информации о процессоре.' >&2
      exit 1
    }
    sed -i 's|/01_info/03_info_router.sh|/01_info/08_info_router.sh|g' /opt/etc/init.d/S05xkeen || exit 1
  fi
  chmod 600 /opt/etc/xray/configs/00_config.json
  chmod 755 /opt/etc/init.d/S05xkeen
  XRAY_LOCATION_ASSET=/opt/etc/xray/dat /opt/sbin/xray -test -confdir /opt/etc/xray/configs || exit 1
  FRESH_CORE=true
  rm -rf "$work"
}

spinner() {
  local pid=$1 msg=$2
  trap 'kill "$pid" 2>/dev/null; printf "\r${RED} ❌ ${NC}%s\033[K\n" "$msg"; printf "\033[?25h"; return 130' INT
  set -- ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
  printf "\033[?25l"
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r${GREEN} %s ${NC} %s\033[K" "$1" "$msg"
    set -- "$@" "$1"
    shift
    usleep 100000
  done
  printf "\033[?25h"
  wait "$pid" && printf "\r ✔  %s\033[K\n" "$msg" || { printf "\r ❌ %s\033[K\n" "$msg"; return 1; }
}

get_arch() {
  case "$(opkg print-architecture)" in
    *aarch64*) ARCH='arm64-v8a' ;;
    *mipsel*)  ARCH='mips32le' ;;
    *mips*)    ARCH='mips32' ;;
    *) printf "${RED_BOLD}\n Не удалось определить архитектуру.${NCN}" >&2; exit 1 ;;
  esac
}

download_files() {
  local release_repo="Fikisq/xkeen-csqtt"
  local base_url="https://github.com/$release_repo/releases"
  local download_url=
  local bin_name="xkeen-ui-$ARCH"

  BIN_STAGED=$(mktemp /opt/tmp/xkeen-ui.XXXXXX) || exit 1
  if [ "$LOCAL" = true ] && [ -f "/opt/tmp/$bin_name" ]; then
    ( set -e; cp "/opt/tmp/$bin_name" "$BIN_STAGED" && chmod +x "$BIN_STAGED" ) &
    if ! spinner $! "Локальная установка бинарника..."; then
      printf "${RED_BOLD}\n Не удалось подготовить бинарник.${NCN}"
      exit 1
    fi
  else
    local release_tag
    if [ "$BETA" = true ]; then
      release_tag=$(curl -fsSL "https://api.github.com/repos/$release_repo/releases" | \
        jq -re '[.[] | select(.prerelease == true)][0].tag_name') || {
        printf "${RED_BOLD}\n Нет актуального бета-релиза форка.${NCN}"
        exit 1
      }
    else
      release_tag=$(curl -fsSL "https://api.github.com/repos/$release_repo/releases" | \
        jq -re '[.[] | select(.prerelease == false and .draft == false)][0].tag_name') || {
        printf "${RED_BOLD}\n Нет опубликованного релиза форка.${NCN}"
        exit 1
      }
    fi
    download_url="$base_url/download/$release_tag"
    SUM_FILE=$(mktemp /opt/tmp/xkeen-sha256.XXXXXX) || exit 1
    ( set -e; curl -fLsS -o "$BIN_STAGED" "$download_url/$bin_name" &&
      curl -fLsS -o "$SUM_FILE" "$download_url/SHA256SUMS" ) &
    if ! spinner $! "Загрузка бинарника..."; then
      printf "${RED_BOLD}\n Релиз форка или его контрольная сумма недоступны.${NCN}"
      exit 1
    fi
    local expected actual
    expected=$(awk -v name="$bin_name" '$2 == name { print $1; exit }' "$SUM_FILE")
    actual=$(sha256sum "$BIN_STAGED" | awk '{print $1}')
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
      printf "${RED_BOLD}\n Контрольная сумма бинарника не совпадает.${NCN}"
      exit 1
    fi
    chmod +x "$BIN_STAGED"
    if [ ! -x /opt/sbin/xray ] || [ ! -x /opt/etc/init.d/S05xkeen ]; then
      local bootstrap_name="xkeen-bootstrap-arm64-v8a.tar.gz"
      BOOTSTRAP_STAGED=$(mktemp /opt/tmp/xkeen-bootstrap.XXXXXX) || exit 1
      curl -fLsS -o "$BOOTSTRAP_STAGED" "$download_url/$bootstrap_name" || exit 1
      expected=$(awk -v name="$bootstrap_name" '$2 == name { print $1; exit }' "$SUM_FILE")
      actual=$(sha256sum "$BOOTSTRAP_STAGED" | awk '{print $1}')
      [ -n "$expected" ] && [ "$expected" = "$actual" ] || {
        echo 'Контрольная сумма первоначальной настройки не совпадает.' >&2; exit 1
      }
    fi
    if [ "$ARCH" = arm64-v8a ]; then
      local nfqws_name="xkeen-nfqws2-arm64-v8a.tar.gz"
      NFQWS_STAGED=$(mktemp /opt/tmp/xkeen-nfqws2.XXXXXX) || exit 1
      NFQWS_STAGED_OWNED=true
      curl -fLsS -o "$NFQWS_STAGED" "$download_url/$nfqws_name" || {
        printf "${RED_BOLD}\n Компонент nfqws2 отсутствует в релизе.${NCN}"
        exit 1
      }
      expected=$(awk -v name="$nfqws_name" '$2 == name { print $1; exit }' "$SUM_FILE")
      actual=$(sha256sum "$NFQWS_STAGED" | awk '{print $1}')
      if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
        printf "${RED_BOLD}\n Контрольная сумма nfqws2 не совпадает.${NCN}"
        exit 1
      fi
    fi
  fi
  if [ "$ARCH" = arm64-v8a ] && [ -z "$NFQWS_STAGED" ] && [ -f /opt/tmp/xkeen-nfqws2-arm64-v8a.tar.gz ]; then
    NFQWS_STAGED=/opt/tmp/xkeen-nfqws2-arm64-v8a.tar.gz
  fi
}

install_nfqws2() {
  [ "$ARCH" = arm64-v8a ] || {
    printf "${YELLOW}\n nfqws2 включён в установщик пока только для ARM64.${NC}\n"
    return 0
  }
  # The upstream bootstrap creates this parent as 0700. The nfqws2 engine
  # drops to nobody before reading Lua assets; allow traversal, not listing.
  mkdir -p /opt/etc/xkeen || exit 1
  chmod 711 /opt/etc/xkeen || exit 1
  # A working local installation is user data: do not replace its engine or strategy.
  if [ -x "$NFQWS_ROOT/engine" ] && [ -x "$NFQWS_ROOT/canary.sh" ]; then
    if [ -n "$NFQWS_STAGED" ]; then
      local helpers
      helpers=$(mktemp -d /opt/tmp/xkeen-nfqws2-helpers.XXXXXX) || exit 1
      tar -xzf "$NFQWS_STAGED" -C "$helpers" || exit 1
      for helper in canary.sh probe-check.sh activate.sh; do
        [ -s "$helpers/$helper" ] || exit 1
        cp "$helpers/$helper" "$NFQWS_ROOT/$helper.new" && chmod 755 "$NFQWS_ROOT/$helper.new" &&
          mv "$NFQWS_ROOT/$helper.new" "$NFQWS_ROOT/$helper" || exit 1
      done
      # Diagnostic runtime only; the active nfqws2 engine and strategy remain user data.
      [ -s "$helpers/probe" ] && cp "$helpers/probe" "$NFQWS_ROOT/probe.new" && chmod 755 "$NFQWS_ROOT/probe.new" &&
        "$NFQWS_ROOT/probe.new" -version | grep -q '^xkeen-nfqws-probe 4$' && mv "$NFQWS_ROOT/probe.new" "$NFQWS_ROOT/probe" || exit 1
      for blob in fs_quic_google fs_tls_max; do
        [ ! -s "$helpers/nfqws2/blobs/$blob.bin" ] || cp "$helpers/nfqws2/blobs/$blob.bin" "$NFQWS_ROOT/nfqws2/blobs/$blob.bin" || exit 1
      done
      [ -s "$helpers/S98nfqws2-xkeen" ] || exit 1
      cp "$helpers/S98nfqws2-xkeen" /opt/etc/init.d/S98nfqws2-xkeen.new &&
        chmod 755 /opt/etc/init.d/S98nfqws2-xkeen.new &&
        mv /opt/etc/init.d/S98nfqws2-xkeen.new /opt/etc/init.d/S98nfqws2-xkeen || exit 1
      rm -rf "$helpers"
    fi
    printf "${INFO} Скрипты nfqws2 обновлены; движок и стратегии сохранены.${NC}\n"
    return 0
  fi
  [ -n "$NFQWS_STAGED" ] || {
    printf "${YELLOW}\n Архив nfqws2 не найден; панель установлена без этого компонента.${NC}\n"
    return 0
  }
  local unpacked
  unpacked=$(mktemp -d /opt/tmp/xkeen-nfqws2-unpack.XXXXXX) || exit 1
  if ! tar -xzf "$NFQWS_STAGED" -C "$unpacked" ||
     [ ! -s "$unpacked/engine" ] || [ ! -s "$unpacked/probe" ] ||
     [ ! -s "$unpacked/canary.sh" ] || [ ! -s "$unpacked/probe-check.sh" ] || [ ! -s "$unpacked/activate.sh" ] ||
     [ ! -s "$unpacked/nfqws2/lua/zapret-lib.lua.gz" ] ||
     [ ! -s "$unpacked/nfqws2/lua/zapret-antidpi.lua.gz" ] ||
     [ ! -s "$unpacked/nfqws2/blobs/quic_initial.bin" ] ||
     [ ! -s "$unpacked/nfqws2/blobs/tls_clienthello.bin" ]; then
    rm -rf "$unpacked"
    printf "${RED_BOLD}\n Архив nfqws2 повреждён или неполон.${NCN}"
    exit 1
  fi
  mkdir -p "$NFQWS_ROOT/nfqws2/lua" "$NFQWS_ROOT/nfqws2/blobs"
  cp "$unpacked/engine" "$unpacked/probe" "$unpacked/canary.sh" "$unpacked/probe-check.sh" "$unpacked/activate.sh" "$NFQWS_ROOT/" || exit 1
  cp "$unpacked/nfqws2/lua/"*.gz "$NFQWS_ROOT/nfqws2/lua/" || exit 1
  cp "$unpacked/nfqws2/blobs/"*.bin "$NFQWS_ROOT/nfqws2/blobs/" || exit 1
  chmod 755 "$NFQWS_ROOT/engine" "$NFQWS_ROOT/probe" "$NFQWS_ROOT/canary.sh" "$NFQWS_ROOT/probe-check.sh" "$NFQWS_ROOT/activate.sh"
  cp "$unpacked/S98nfqws2-xkeen" /opt/etc/init.d/S98nfqws2-xkeen || exit 1
  chmod 755 /opt/etc/init.d/S98nfqws2-xkeen
  rm -rf "$unpacked"
  printf "${SUCCESS} nfqws2 установлен. Маршруты не переключались.${NC}\n"
}

install_prepared() {
  mv "$BIN_STAGED" "$XKEENUI_BIN" && chmod +x "$XKEENUI_BIN" || exit 1
  BIN_STAGED=
}

repair_existing_core() {
  # Keep the two user-facing device lists visible on a clean installation.
  local device_list
  for device_list in client_bypass_macs.lst device_capture_xray.lst; do
    if [ ! -e "/opt/etc/xkeen/$device_list" ]; then
      (umask 077; : > "/opt/etc/xkeen/$device_list") || exit 1
    fi
  done
  # Preserve the installed init settings; repair only the old module path.
  if [ ! -r /opt/sbin/.xkeen/01_info/03_info_router.sh ] &&
     [ -r /opt/sbin/.xkeen/01_info/08_info_router.sh ]; then
    sed -i 's|/01_info/03_info_router.sh|/01_info/08_info_router.sh|g' /opt/etc/init.d/S05xkeen || exit 1
  fi
  # Migrate our earlier bootstrap's local API without changing any routes.
  [ "$FRESH_CORE" != true ] || return 0
  local config=/opt/etc/xray/configs/00_config.json work fragment
  jq -e '.api.listen == "127.0.0.1:18085" and (.api.services | type == "array") and (.api.services | index("RoutingService") != null)' "$config" >/dev/null || return 0
  jq -e '.api.services | index("HandlerService") != null' "$config" >/dev/null && return 0
  work=$(mktemp -d /opt/tmp/xkeen-api-upgrade.XXXXXX) || exit 1
  chmod 700 "$work"
  for fragment in /opt/etc/xray/configs/*.json; do
    [ ! -f "$fragment" ] || cp -p "$fragment" "$work/" || exit 1
  done
  jq '.api.services += ["HandlerService"]' "$config" > "$work/00_config.json" || exit 1
  chmod 600 "$work/00_config.json"
  XRAY_LOCATION_ASSET=/opt/etc/xray/dat /opt/sbin/xray -test -confdir "$work" || exit 1
  mkdir -p /opt/backups
  CORE_API_BACKUP="/opt/backups/xray-before-api-upgrade-$(date +%Y%m%d%H%M%S).json"
  cp -p "$config" "$CORE_API_BACKUP" && chmod 600 "$CORE_API_BACKUP" || exit 1
  cp "$work/00_config.json" "$config.api-new" && chmod 600 "$config.api-new" && mv "$config.api-new" "$config" || exit 1
  rm -rf "$work"
  pidof xray >/dev/null && CORE_API_RESTART=true || true
}

start_required_core() {
  if [ "$FRESH_CORE" = true ]; then
    /opt/etc/init.d/S05xkeen start on || exit 1
    pidof xray >/dev/null || { echo 'Xray не запустился; проверьте /opt/var/log/xray/error.log.' >&2; exit 1; }
  elif [ "$CORE_API_RESTART" = true ]; then
    printf '\n Включение API подписок: один перезапуск Xray...\n'
    if ! /opt/etc/init.d/S05xkeen restart on || ! pidof xray >/dev/null; then
      cp -p "$CORE_API_BACKUP" /opt/etc/xray/configs/00_config.json
      /opt/etc/init.d/S05xkeen restart on || true
      "$XKEENUI_INIT" start || true
      echo 'Миграция API не завершилась; восстановлена прежняя конфигурация.' >&2
      exit 1
    fi
  fi
}

ensure_conntrack() {
  command -v conntrack >/dev/null 2>&1 && return 0
  printf "\n Установка conntrack для сброса старых соединений при смене режима устройства...\n"
  opkg install conntrack || printf "\n conntrack не установлен. После смены режима может понадобиться переподключить сеть устройства.\n"
}

install_geodata() {
  if "$BIN_STAGED" --help 2>/dev/null | grep -q geodata-download; then
    printf "\n Загрузка и проверка баз RoscomVPN и GeoSite...\n"
    "$BIN_STAGED" geodata-download || {
      printf "${RED_BOLD}\n Не удалось проверить базы. Установка панели остановлена.${NCN}"
      exit 1
    }
  else
    printf "\n Этот релиз панели ещё не поддерживает автоматическую установку геобаз.\n"
  fi
}

initialize_panel_storage() {
  mkdir -p /opt/backups /opt/var/log/xray /opt/var/log/mihomo || exit 1
  # Empty on first installation; updates preserve every existing log and archive.
  local logfile
  for logfile in /opt/var/log/xray/access.log /opt/var/log/xray/error.log /opt/var/log/mihomo/error.log \
    /opt/var/log/xkeen-ui.log "$NFQWS_ROOT/nfqws2.log"; do
    [ -d "$(dirname "$logfile")" ] || continue
    if [ ! -e "$logfile" ]; then
      (umask 077; set -C; : > "$logfile") || exit 1
    fi
  done
}

seed_mihomo_rulesets() {
  [ "$FRESH_CORE" = true ] || return 0
  local directory=/opt/etc/mihomo/ruleset name url temporary size signature
  mkdir -p "$directory" || {
    printf '\n Не удалось создать каталог дополнительных rule-set Mihomo; геобазы и основные правила доступны.\n' >&2
    return 0
  }
  for name in metacubex-discord metacubex-telegram-ips; do
    # Existing provider files are user data, even on a partial first install.
    [ ! -e "$directory/$name.mrs" ] && [ ! -L "$directory/$name.mrs" ] || continue
    case "$name" in
      metacubex-discord) url=https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/discord.mrs ;;
      metacubex-telegram-ips) url=https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/telegram.mrs ;;
    esac
    temporary=$(mktemp "$directory/.initial-mrs.XXXXXX") || continue
    if curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 \
      --max-filesize 1048576 --retry 2 "$url" -o "$temporary"; then
      size=$(wc -c < "$temporary" | tr -d '[:space:]')
      # MRS is a Zstandard stream. Reject empty downloads and HTML/error pages;
      # the core fully decodes the provider before using its rules.
      signature=$(head -c 4 "$temporary" | od -b | awk 'NR == 1 { print $2 $3 $4 $5 }')
      if [ "$size" -ge 16 ] && [ "$size" -le 1048576 ] && [ "$signature" = 050265057375 ]; then
        chmod 644 "$temporary"
        # Atomic same-filesystem publication with no replacement, including races.
        ln "$temporary" "$directory/$name.mrs" && rm -f "$temporary" && continue
      fi
    fi
    rm -f "$temporary"
    printf '\n Дополнительный rule-set %s не загружен; Mihomo повторит загрузку при запуске. Основные правила используют геобазы.\n' "$name" >&2
  done
}

create_initial_backup() {
  [ "$FIRST_PANEL" = true ] || return 0
  local archive="/opt/backups/initial-$(date +%Y%m%d-%H%M%S)_xkeen-ui.tar" file
  set --
  for file in /opt/etc/xray/configs/*.json /opt/etc/mihomo/*.yaml /opt/etc/mihomo/*.yml \
    /opt/etc/mihomo/proxy_providers/*.yaml /opt/etc/mihomo/proxy_providers/*.yml \
    /opt/etc/xkeen/*.json /opt/etc/xkeen/*.lst /opt/etc/xkeen/xray-subscription-url \
    /opt/etc/xkeen/global_direct_xray.flag /opt/etc/xkeen/global_direct_mihomo.flag \
    /opt/etc/csqtt/csqtt.conf /opt/etc/csqtt/vk_token \
    /opt/etc/wdtt-plus/wdtt-plus.conf /opt/etc/wdtt-plus/password /opt/etc/wdtt-plus/device_id \
    /opt/etc/wdtt-plus/vk_token /opt/etc/wdtt-plus/rt-masque-v1.json; do
    [ ! -f "$file" ] || set -- "$@" "${file#/}"
  done
  [ "$#" -gt 0 ] || return 1
  # Same configuration-only archive format as the panel. Preserve this router's
  # own settings securely; never ship another router's backups in the release.
  (umask 077; tar -hcf "$archive.new" -C / "$@") || exit 1
  mv "$archive.new" "$archive" || exit 1
}

install_xkeenui() {
  # Capture before replacing the executable: an existing XKeen core can still
  # receive its first panel and needs an initial snapshot of its own settings.
  if [ ! -e "$XKEENUI_BIN" ] && [ ! -e "$STATIC_DIR" ] && [ ! -e "$LIGHTTPD_CONF" ]; then
    FIRST_PANEL=true
  fi
  check_existing_core
  ensure_conntrack
  [ -f "/opt/tmp/xkeen-ui-$ARCH" ] && LOCAL=true
  download_files
  install_geodata
  prepare_core
  seed_mihomo_rulesets
  install_nfqws2
  if [[ -d $STATIC_DIR || -f $XKEENUI_BIN || -f $XKEENUI_INIT || -f $LIGHTTPD_CONF ]]; then
    printf "${YELLOW}\n Обнаружены файлы XKeen UI, запуск переустановки...\n${NC}"
    uninstall_xkeenui
  fi

  printf "${INFO} Начинаем установку...${NCN}"

  install_prepared; create_xkeenui_init
  repair_existing_core
  initialize_panel_storage
  create_initial_backup
  "$XKEENUI_BIN" install-clients || {
    echo 'Панель установлена, но загрузка дополнительных клиентов не завершилась. Повторите команду или установите их кнопкой в панели.' >&2
    exit 1
  }
  start_required_core

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start &>/dev/null &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.${NCN}"
    exit 1
  fi

  finish_setup "установлен"
}

update_xkeenui() {
  check_existing_core
  ensure_conntrack
  [ -f "$XKEENUI_BIN" ] || { printf "${ERROR} Ошибка: XKeen UI не установлен!${NCN}"; exit 1; }
  [ -f "/opt/tmp/xkeen-ui-$ARCH" ] && LOCAL=true
  download_files
  install_geodata
  prepare_core
  install_nfqws2

  printf "${INFO} Начинаем обновление...${NCN}"

  if [ ! -f $XKEENUI_INIT ]; then
    (
      set -e
      killall -q -9 xkeen-ui &>/dev/null || :
      create_xkeenui_init
    ) &
    spinner $! "Создание скрипта запуска..."
  elif pidof xkeen-ui &>/dev/null; then
    (
      sed -i 's|^PROCS=/opt/sbin/xkeen-ui$|PROCS=xkeen-ui|' /opt/etc/init.d/S99xkeen-ui
      $XKEENUI_INIT stop &>/dev/null || :
      killall -q -9 xkeen-ui || :
    ) &
    spinner $! "Остановка XKeen UI..."
  else
    sed -i 's|^PROCS=/opt/sbin/xkeen-ui$|PROCS=xkeen-ui|' /opt/etc/init.d/S99xkeen-ui
  fi

  legacy_installation_check; install_prepared
  repair_existing_core
  initialize_panel_storage
  "$XKEENUI_BIN" install-clients || exit 1
  start_required_core

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start &>/dev/null &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.${NCN}"
    exit 1
  fi

  finish_setup "обновлен"
}

uninstall_xkeenui() {
  printf "\n Данное действие ${RED_BOLD}удалит${NC} XKeen UI, его файлы и зависимости.\n\n"
  read -p " Продолжить? [y/N]: " response < /dev/tty
  response=$(printf '%s' "$response" | tr -cd 'YyNn')
  case "$response" in
    [Yy]) printf "${INFO} Начинаем удаление...${NCN}";;
    *) printf "${ERROR} Отмена операции.${NCN}"; exit 1;;
  esac

  (
    if [[ -f "$LIGHTTPD_INIT" && -f "$LIGHTTPD_CONF" ]]; then
      if $LIGHTTPD_INIT status &>/dev/null; then
          $LIGHTTPD_INIT stop &>/dev/null || :
          opkg remove --autoremove --force-removal-of-dependent-packages lighttpd &>/dev/null
          rm -rf $LIGHTTPD_DIR
      fi
    fi
    if [ -f $XKEENUI_INIT ]; then
      if $XKEENUI_INIT status &>/dev/null; then
        $XKEENUI_INIT stop &>/dev/null || :
        killall -q -9 xkeen-ui || :
      fi
    fi
  ) &
  spinner $! "Остановка XKeen UI..."

  (rm -rf $STATIC_DIR; rm -f $XKEENUI_BIN $XKEENUI_INIT) &
  spinner $! "Удаление файлов XKeen UI..."
  printf "${SUCCESS} Удаление XKeen-UI завершено${NCN}"
}

finish_setup() {
  local ip=$(ip -4 a s br0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p'); ip=${ip:-"IP_Роутера"}
  local port=$(sed -n 's/.*-p \([0-9]*\).*/\1/p' $XKEENUI_INIT 2>/dev/null); port=${port:-1000}

  printf "${SUCCESS} XKeen UI успешно $1!${NCN}"
  printf " Панель доступна по адресу: ${GREEN_BOLD}http://$ip:$port${NC}\n\n"
}

legacy_installation_check() {
  if [ -f "$LIGHTTPD_CONF" ]; then
    $LIGHTTPD_INIT status &>/dev/null && $LIGHTTPD_INIT stop
    rm -f "$LIGHTTPD_CONF"
    printf "${YELLOW}\n Веб-сервер lighttpd для работы XKeen UI более не используется.\n${NC}"
    read -p " Удалить его? [Y/n]: " response < /dev/tty
    response=$(printf '%s' "$response" | tr -cd 'YyNn')
    case "$response" in
      [Nn]) return;;
      *) opkg remove --autoremove --force-removal-of-dependent-packages lighttpd; rm -rf $LIGHTTPD_DIR;;
    esac
  fi
}

create_xkeenui_init() {
  cat << EOF > $XKEENUI_INIT
#!/bin/sh

ENABLED=yes
PROCS=xkeen-ui
ARGS="-p 1000"
PREARGS=""
DESC="\$PROCS"
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
EOF
  chmod +x $XKEENUI_INIT
}

get_status() {
  [ ! -f "$XKEENUI_BIN" ] && printf "Статус панели: ${RED_BOLD}не установлена${NC}" && return

  local version=$($XKEENUI_BIN -v 2>/dev/null | awk 'NR==1{print $3}')
  local status="${RED_BOLD}не запущена"

  version=${version:-"N/A"}

  pidof xkeen-ui &>/dev/null && status="${GREEN_BOLD}запущена"
  printf "Статус панели: $status ${NC}[$version]"
}

prepare_entware
[ ! -t 1 ] || clear
get_arch
[ "$ARCH" = arm64-v8a ] || { echo 'Готовая установка пока доступна только для ARM64.' >&2; exit 1; }
if [ "$AUTO" = true ]; then
  if [ -f "$XKEENUI_BIN" ]; then update_xkeenui; else install_xkeenui; fi
  exit $?
fi
printf "${CYAN}"
cat <<'EOF'
   _  __  __ __                       __  __ ____
  | |/ / / //_/___   ___   ____      / / / //  _/
  |   / / ,<  / _ \ / _ \ / __ \    / / / / / /
 /   | / /| |/  __//  __// / / /   / /_/ /_/ /
/_/|_|/_/ |_|\___/ \___//_/ /_/    \____//___/
EOF

printf "${NC}\n$(get_status)\n"
printf "Архитектура: ${GREEN_BOLD}$ARCH\n"
printf "\nДобро пожаловать! Выберите действие:${NCN}"
printf "  1. Установить/переустановить\n"
printf "  2. Обновить\n"
printf "  3. Удалить\n"
printf "\n  0. Выйти\n\n"

read -p "${GREEN_BOLD}>: ${NC}" response < /dev/tty

case $response in
  1) install_xkeenui;;
  2) update_xkeenui;;
  3) uninstall_xkeenui;;
  0) echo; exit;;
  *) printf "${ERROR} Неверный выбор.${NCN}"; exit 1;;
esac
