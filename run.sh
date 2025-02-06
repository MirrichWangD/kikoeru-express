docker run \
  -d \
  --name 'kikoeru' \
  -e TZ='Asia/Shanghai' \
  -p '2333:8888/tcp' \
  -v '/home/ubuntu/Appdata/kikoeru/sqlite':'/usr/src/kikoeru/sqlite':'rw' \
  -v '/home/ubuntu/Appdata/kikoeru/covers':'/usr/src/kikoeru/covers':'rw' \
  -v '/home/ubuntu/Appdata/kikoeru/config':'/usr/src/kikoeru/config':'rw' \
  -v '/mnt/BasicSeagate/Media/Music/DLsite':'/usr/src/kikoeru/VoiceWork':'rw' \
  'mirrichwangd/kikoeru'
