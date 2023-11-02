#!/usr/bin/env bash

if [ -f /bin/systemctl ]; then
  sudo /bin/systemctl reload nginx # There is no systemd config command
else
  sudo /etc/init.d/nginx configtest
fi
