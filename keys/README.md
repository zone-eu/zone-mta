# DKIM keys folder

Place DKIM signing keys here. If you need to store DKIM keys in some other folder, change the folder path in the config file. Currently all DKIM keys are loaded into memory on startup, so having a lot of keys might slow things down a bit.

Key name format: {domain}.{selector}.pem

For example:

Domain name: müriaad-polüteism.info
Key selector: myselector
File name: xn--mriaad-polteism-zvbj.info.myselector.pem
