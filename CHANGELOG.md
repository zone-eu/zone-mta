# CHANGELOG

-   v1.17.0 2019-06-14

    -   Fixed O365 bounce msg. (jpbede)
    -   Make plugin api doc clear (jpbede)
    -   Plugin HTTP API (jpbede)
    -   DKIM: Configurable headers to sign (jpbede)
    -   Make default zone configurable (jpbede)
    -   Added new hook "smtp:connect" (jpbede)
    -   added new outlook blacklist response
    -   Add gmail block and odd greylist bounces (louis-lau)'

-   v1.16.3 2019-06-14

    -   Do not cache failed STARTTLS info, always try encryption first

-   v1.16.1 2019-06-10

    -   Bumped dependencies to get rid of security warnings
    -   Some new blacklist filters

-   v1.16.0 2019-04-04

    -   Added new hook "sender:delivered"

-   v1.15.6 2019-03-21

    -   Reverted Restify from 8 to 7 as 8 does not support Node v6
    -   Convert line endings for incoming messages to always use 0x0D 0x0A, otherwise DKIM might get messed up

-   v1.15.5 2019-03-18

    -   Added new headers to DKIM list

-   v1.15.4 2019-02-20

    -   Fixed a typo in blacklist detection patterns

-   v1.15.0 2019-01-24

    -   Fixed broken TLS support on connection

-   v1.14.0 2019-01-04

    -   Fixed useProxy setting

-   v1.13.0 2018-10-23

    -   Added option for plugins to send messages to Graylog

-   v1.12.1 2018-10-19

    -   Log connection errors to MX servers

-   v1.12.0 2018-09-24

    -   Allow overrideing database entry keys for deferred messages using `delivery.updates = {keys}`

-   v1.11.0 2018-09-14

    -   Allow disabled bounce emails for messages from specific interfaces

-   v1.10.8 2018-09-12

    -   Fixed issue with missing CA certs

-   v1.10.4 2018-08-22

    -   Fixed an issue with MX connection timeouts where a working MX exisits but never was tried

-   v1.10.2 2018-08-16

    -   Fixed broken relay

-   v1.10.0 2018-07-30

    -   Bumped dependencies. Upgraded MongoDB driver to 3.1.

-   v1.8.4 2018-05-25

    -   Fixed `host` option for zones

-   v1.8.1 2018-05-22

    -   Use delivery object for the connect hook argument

-   v1.8.0 2018-05-17

    -   Offload TCP connections for MX to mx-connect module

-   v1.7.3 2018-04-28

    -   Fixed race condition with Redis on large number of sending zone processes

-   v1.7.0 2018-04-17

    -   Allow using SMTP [server options](https://nodemailer.com/extras/smtp-server/#step-3-create-smtpserver-instance) for SMTP interfaces

-   v1.6.0 2018-02-08

    -   Changed index handling. Indexes are defined in indexes.yaml instead of being hard coded to mail-queue.js
    -   Do not search using \$ne, instead a separate index was added

---

-   v1.0.0-beta.25 2017-03-13

    -   Drop LevelDB support entirely, use MongoDB for all storage related stuff

-   v1.0.0-beta.16 2017-01-30

    -   Start using MongoDB GridFS for message storage instead of storing messages in LevelDB. This is an external requirement, MongoDB does not come bundled with ZoneMTA

-   v1.0.0-beta.3 2017-01-02

    -   Log message data to UDP

-   v1.0.0-beta.2 2016-12-23

    -   Do not store deleted messages, remove everything in the first possible moment

-   v0.1.0-alpha.8 2016-10-05

    -   Added cli command "zone-mta" to create and run ZoneMTA applications
    -   Added API endpoint to check message status in queue
    -   Added new plugin option (`app.addStreamHook`) to process attachment streams without modifying the message. This can be used to store attachments to disk or calculating hashes etc. on the fly

-   v0.1.0-alpha.5 2016-09-25

    -   Allow multiple SMTP interfaces (one for 465, one for 587 etc)

-   v0.1.0-alpha.4 2016-09-21

    -   Added option to log to syslog instead of stderr

-   v0.1.0-alpha.3 2016-09-21

    -   Added plugin system to be able to easily extend ZoneMTA
    -   Added plugin to use Rspamd for message scanning
    -   Added plugin to send bounce notifications either to an URL or email address or both
    -   Converted built-in HTTP calls to optional plugins (authentication, sender config etc)
    -   Allow total or partial message rewriting through the rewrite API

-   v0.1.0-alpha.2 2016-09-06

    -   Added option to forward messages of a Zone not to MX but to another predefined MTA

-   v0.1.0-alpha.1 2016-09-06
    -   Initial release
