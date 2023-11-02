#!/usr/bin/env bash

if [ -f /bin/systemctl ]; then
  sudo /bin/systemctl reload nginx
else
  sudo /etc/init.d/nginx reload
fi
