# GELF Codes

All GELF short messages are prefixed with `<COMPONENT> [<CODE>]`, where
`COMPONENT` is the uppercase value of `config.log.gelf.component` (default: `MTA`).

## Codes and reasons

| Code | Reason |
| --- | --- |
| API_START_FAILED | Could not start API server. |
| BOUNCE_RULES_LOAD_FAILED | Could not load bounce rules. |
| BOUNCE_RULE_REGEX_INVALID | Invalid bounce rule regex. |
| BOUNCE_SEND_FAILED | Failed to enqueue bounce message. |
| DELIVERY_ACK_FAILED | Failed to acknowledge delivered message. |
| DELIVERY_DEFER_FAILED | Failed to defer delivery. |
| DELIVERY_RELEASE_FAILED | Failed to release delivery. |
| DELIVERY_UNEXPECTED_STATE | Delivery completed after connection ended. |
| DNS_REDIS_GET_FAILED | Failed to get DNS cache. |
| DNS_REDIS_SET_FAILED | Failed to set DNS cache. |
| DNS_REVERSE_FAILED | Failed to reverse IP address. |
| FETCH_LOAD_FAILED | Failed to load message (API fetch). |
| MTA_STS_REDIS_ERROR | MTA-STS Redis error. |
| MX_CONNECT_ERROR | MX connection error. |
| MX_CONNECT_FAILED | Could not connect to MX. |
| MX_UNEXPECTED_ERROR | Unexpected MX error. |
| QUEUE_CONNECT_FAILED | Could not connect to queue server. |
| QUEUE_CONNECTION_CLOSED | Queue server connection closed unexpectedly. |
| QUEUE_CONNECTION_ERROR | Queue server connection error. |
| QUEUE_COUNTERS_FAILED | Failed to fetch queue counters. |
| QUEUE_DB_INIT_FAILED | Could not initialize queue database. |
| QUEUE_DELAYED_HOOK_FAILED | queue:delayed hook failed. |
| QUEUE_DELETE_FAILED | Failed to delete delivery. |
| QUEUE_ERROR | Queue error. |
| QUEUE_FETCH_FAILED | Failed to fetch message body. |
| QUEUE_FETCH_UNEXPECTED | Unexpected message fetch failure. |
| QUEUE_GC_FAILED | Garbage collection failed. |
| QUEUE_INDEX_CREATE_FAILED | Failed to create MongoDB index. |
| QUEUE_INIT_FAILED | Could not initialize sending queue. |
| QUEUE_META_FAILED | Failed to store queue metadata. |
| QUEUE_META_FETCH_FAILED | Failed to fetch delivery metadata. |
| QUEUE_PUSH_FAILED | Failed to push message to queue. |
| QUEUE_REQUEST_FAILED | Failed to fetch delivery from queue. |
| QUEUE_SERVER_START_FAILED | Could not start queue server. |
| QUEUE_STORE_FAILED | Failed to store message stream or queued message. |
| REDIS_CONNECTION_ERROR | Redis connection error. |
| SENDER_DELIVERED_HOOK_FAILED | sender:delivered hook failed. |
| SENDER_EXITED | Sender process exited unexpectedly. |
| SENDER_START_TIMEOUT | Sender process startup timeout. |
| SENDER_UNKNOWN_ZONE | Unknown sending zone. |
| SETGID_FAILED | Failed to change group. |
| SETUID_FAILED | Failed to change user. |
| SMTP_CONNECTION_ERROR | SMTP connection error. |
| SMTP_ERROR | SMTP server error. |
| SMTP_FILE_ACCESS_FAILED | Failed to access server file (TLS key/cert/CA). |
| SMTP_QUEUE_INIT_FAILED | Failed to initialize SMTP queue. |
| SMTP_RECEIVER_EXITED | Receiver process exited unexpectedly. |
| SMTP_RECEIVER_START_FAILED | Failed to start SMTP interface (receiver). |
| SMTP_SERVER_ERROR | SMTP server error (debug context). |
| SMTP_SOCKET_ERROR | SMTP socket error. |
| SMTP_START_FAILED | Could not start SMTP interface (master). |
| SMTP_TLS_SETUP_FAILED | Failed to set up TLS. |
| UNCAUGHT_EXCEPTION | Uncaught exception in master process. |
