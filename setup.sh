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
LOCAL=false
BIN_STAGED=
SUM_FILE=
NFQWS_STAGED=
NFQWS_STAGED_OWNED=false
NFQWS_ROOT="/opt/etc/xkeen/nfqws2-stage"
cleanup_download() {
  [ -z "$BIN_STAGED" ] || rm -f "$BIN_STAGED"
  [ -z "$SUM_FILE" ] || rm -f "$SUM_FILE"
  [ "$NFQWS_STAGED_OWNED" != true ] || rm -f "$NFQWS_STAGED"
}
trap cleanup_download EXIT
[ "$1" = "beta" ] && BETA=true

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
        jq -re '.[0].tag_name') || {
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
  # A working local installation is user data: do not replace its engine or strategy.
  if [ -x "$NFQWS_ROOT/engine" ] && [ -x "$NFQWS_ROOT/canary.sh" ]; then
    if [ ! -x "$NFQWS_ROOT/activate.sh" ] && [ -n "$NFQWS_STAGED" ]; then
      local helpers
      helpers=$(mktemp -d /opt/tmp/xkeen-nfqws2-helpers.XXXXXX) || exit 1
      if tar -xzf "$NFQWS_STAGED" -C "$helpers" ./activate.sh && [ -s "$helpers/activate.sh" ]; then
        cp "$helpers/activate.sh" "$NFQWS_ROOT/activate.sh" && chmod 755 "$NFQWS_ROOT/activate.sh"
      fi
      rm -rf "$helpers"
    fi
    printf "${INFO} Существующая установка nfqws2 сохранена.${NC}\n"
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

install_xkeenui() {
  [ -f "/opt/tmp/xkeen-ui-$ARCH" ] && LOCAL=true
  download_files
  install_nfqws2
  if [[ -d $STATIC_DIR || -f $XKEENUI_BIN || -f $XKEENUI_INIT || -f $LIGHTTPD_CONF ]]; then
    printf "${YELLOW}\n Обнаружены файлы XKeen UI, запуск переустановки...\n${NC}"
    uninstall_xkeenui
  fi

  printf "${INFO} Начинаем установку...${NCN}"

  install_prepared; create_xkeenui_init

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start &>/dev/null &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.${NCN}"
    exit 1
  fi

  finish_setup "установлен"
}

update_xkeenui() {
  [ -f "$XKEENUI_BIN" ] || { printf "${ERROR} Ошибка: XKeen UI не установлен!${NCN}"; exit 1; }
  [ -f "/opt/tmp/xkeen-ui-$ARCH" ] && LOCAL=true
  download_files
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

clear
get_arch
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
