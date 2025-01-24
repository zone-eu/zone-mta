const swaggerJSDoc = require('swagger-jsdoc')

const swaggerDefinition = {
  openapi: '3.1.0',
  tags: [
    {
      name: 'Message',
      description: 'Endpoints used in accessing message objects'
    }
  ],
  paths: {
    '/plugin/epost-rest/message/send': {
      post: {
        tags: ['message'],
        summary: 'Send a message',
        description: 'Use the request parameters to compose and send message(s)',
        operationId: 'send',
        security: [
          {
            BasicAuth: []
          }
        ],
        requestBody: {
          description: 'Compose and send a message',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Messages'
              }
            },
            'application/xml': {
              schema: {
                $ref: '#/components/schemas/Messages'
              }
            },
            'application/x-www-form-urlencoded': {
              schema: {
                $ref: '#/components/schemas/Messages'
              }
            }
          },
          required: true
        },
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/MessageSuccessResult'
                }
              }
            }
          },
          400: {
            description: 'Bad Request',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/MessageErrorResult'
                }
              }
            }
          },
          401: {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/MessageErrorResult'
                }
              }
            }
          },
          403: {
            description: 'Forbidden',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/MessageErrorResult'
                }
              }
            }
          },
          500: {
            description: 'Internal Server Error',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/MessageErrorResult'
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Messages: {
        type: 'object',
        required: ['messages', 'attachments'],
        properties: {
          messages: {
            type: 'array',
            description: 'An array of messages to deliver.',
            minItems: 1,
            items: {
              type: 'object',
              required: ['deliveryType', 'bounceTo', 'sendingZone', 'emlMode', 'header', 'body'],
              properties: {
                deliveryType: {
                  type: 'string',
                  description: 'Determines the S/MIME settings of the message.<ul><li><code>confidential</code> - message is <b><samp>signed</samp></b> and <b><samp>encrypted</samp></b>.</li><li><code>trusted</code> - message is <b><samp>signed</samp></b>.</li><li><code>public</code> - message is not <b><samp>signed</samp></b> and not <b><samp>encrypted</samp></b>.</li></ul><br>EML header:<ul><li><b><samp>x-epost-dtype</samp></b></li></ul>',
                  default: 'public',
                  enum: ['confidential', 'trusted', 'public']
                },
                emlMode: {
                  type: 'string',
                  description:
                    'Determines how to handle the number of bodies in Zone-MTA.<ul><li><code>compatible</code> - limits the number of body<ul><li>For <b><samp>multipart/alternative</samp></b> - can only have 1 pair of bodies: 1 <b><samp>text/html</samp></b> and 1 <b><samp>text/plain</samp></b>.</li><li>For Other Content Types - can only have 1 body.</li></ul></li><li><code>rfc822</code> - Can have multiple number of bodies.</li></ul>',
                  default: 'rfc822',
                  enum: ['rfc822', 'compatible']
                },
                bounceTo: {
                  type: 'string',
                  description: 'Determines how bounces should be handled in Zone-MTA.<br>EML header:<ul><li><b><samp>x-epost-bounceto</samp></b></li></ul>',
                  default: 'email',
                  enum: ['email', 'eposthub', 'oneapi']
                },
                customerBatchId: {
                  type: 'string',
                  description:
                    "The customer <b><samp>batch-id</samp></b> or <b><samp>batch-name</samp></b> goes here.<br>If not provided, the <b><samp>message-id</samp></b> is used as default.<br>EML header:<ul><li><b><samp>x-epost-cbatchid</samp></b></li></ul>",
                  example: 'uuid@domain.com'
                },
                sendingZone: {
                  type: 'string',
                  description: 'Determines the specific plugin or configuartion to use in Zone-MTA.<br>EML Header:<ul><li><b><samp>x-epost-zone</samp></b></li><li><b><samp>x-sending-zone</samp></b></li></ul>',
                  default: 'default',
                  enum: ['default', 'smtp2mx', 'eposthub', 'aztec']
                },
                language: {
                  type: 'string',
                  description: 'Language the email is written in.<br>Format: 2-Letter ISO Language Code<br>EML Header:<ul><li><b><samp>x-epost-language</samp></b></li></ul>',
                  default: 'en',
                  example: 'en'
                },
                header: {
                  type: 'object',
                  description: 'All email header information goes here.',
                  required: ['from', 'to', 'subject', 'x-header'],
                  properties: {
                    from: {
                      type: 'string',
                      description: 'Single <b>&ldquo;from&rdquo;</b> email address.<br>Supported formats <b>"First Last &lt;first.last@sample.com&gt;"</b> or <b>"first.last@sample.com"</b>.<br>EML header:<ul><li><b><samp>from</samp></b></li></ul>',
                      format: 'email',
                      example: 'address@domain.com'
                    },
                    to: {
                      type: 'array',
                      description: 'All <b>&ldquo;to&rdquo;</b> email addresses.<br>Supported formats <b>"First Last &lt;first.last@sample.com&gt;"</b> or <b>"first.last@sample.com"</b>.<br>Formats can be mixed.<br>EML header:<ul><li><b><samp>to</samp></b></li></ul>',
                      minItems: 1,
                      items: {
                        type: 'string',
                        format: 'email'
                      },
                      example: ['address1@domain.com', 'Name <address2@domain.com>']
                    },
                    cc: {
                      type: 'array',
                      description: 'All <b>&ldquo;cc&rdquo;</b> email addresses.<br>Supported formats <b>"First Last &lt;first.last@sample.com&gt;"</b> or <b>"first.last@sample.com"</b>.<br>Formats can be mixed.<br>EML header:<ul><li><b><samp>cc</samp></b></li></ul>',
                      items: {
                        type: 'string',
                        format: 'email'
                      },
                      example: ['address1@domain.com', 'Name <address2@domain.com>']
                    },
                    bcc: {
                      type: 'array',
                      description: 'All <b>&ldquo;bcc&rdquo;</b> email addresses.<br>Supported formats <b>"First Last &lt;first.last@sample.com&gt;"</b> or <b>"first.last@sample.com"</b>.<br>Formats can be mixed.',
                      items: {
                        type: 'string',
                        format: 'email'
                      },
                      example: ['address1@domain.com', 'Name <address2@domain.com>']
                    },
                    replyTo: {
                      type: 'array',
                      description: 'All <b>&ldquo;reply-to&rdquo;</b> email addresses.<br>Supported formats <b>"First Last &lt;first.last@sample.com&gt;"</b> or <b>"first.last@sample.com"</b>.<br>Formats can be mixed.<br>EML header:<ul><li><b><samp>reply-to</samp></b></li></ul>',
                      items: {
                        type: 'string',
                        format: 'email'
                      },
                      example: ['address1@domain.com', 'Name <address2@domain.com>']
                    },
                    returnPath: {
                      type: 'string',
                      description:
                        'Single <b>&ldquo;sender&rdquo;</b> email address.<br>If not provided, <b>&ldquo;from&rdquo;</b> is used as default.<br>Supported formats <b>"First Last &lt;first.last@sample.com&gt;"</b> or <b>"first.last@sample.com"</b>.<br>EML header:<ul><li><b><samp>sender</samp></b></li></ul>',
                      format: 'email',
                      example: 'address@domain.com'
                    },
                    subject: {
                      type: 'string',
                      description: 'Base64 encoded string of the email subject.<br>EML header:<ul><li><b><samp>subject</samp></b></li></ul>',
                      format: 'base64',
                      example: 'AaBbCc12DdEe34=='
                    },
                    messageId: {
                      type: 'string',
                      description: 'Message Id of the message.<br>If not provided, it will be generated in Zone-MTA.<br>EML Header:<ul><li><b><samp>message-id</samp></b></li></ul>',
                      example: 'uuid@domain.com'
                    },
                    date: {
                      type: 'string',
                      description: 'Date of the message.<br>If not provided, it will be generated in Zone-MTA.<br>EML Header:<ul><li><b><samp>date</samp></b></li></ul>',
                      format: 'date',
                      example: 'Mon, 22 Jan 2025 15:30:45 +0800 (GMT)'
                    },
                    'x-header': {
                      type: 'object',
                      description: 'All special purpose EML Headers goes here.',
                      required: ['x-epost-trackingid', 'x-eposts-tenantid'],
                      properties: {
                        'x-epost-trackingid': {
                          type: 'array',
                          description: 'OneAPI Tracking ID.<br>Used by Zone-MTA plugin for bounce reporting.<br>EML header:<ul><li><b><samp>x-epost-trackingid</samp></b></li></ul>',
                          minItems: 1,
                          items: {
                            type: 'string'
                          },
                          example: [
                            'uuid|address1@domain.com',
                            'uuid|address2@domain.com',
                            'uuid|address3@domain.com'
                          ]
                        },
                        'x-eposts-tenantid': {
                          type: 'string',
                          description: 'OneAPI Tenant ID.<br>Used by Zone-MTA plugin for bounce reporting.<br>EML header:<ul><li><b><samp>x-epost-tenantid/samp></b></li></ul>',
                          example: 'uuid'
                        },
                        'additional-x-header': {
                          type: 'array',
                          description: 'Additional x-headers.<br>Format <b>"<samp>x-header-example: value</samp>"</b>',
                          items: {
                            type: 'string'
                          },
                          example: ['x-header-example1: value', 'x-header-example2: value', 'x-header-example3: value'],
                          uniqueItems: true
                        }
                      }
                    }
                  }
                },
                body: {
                  type: 'array',
                  description: 'All body text or html parts with their content type dependencies.',
                  minItems: 1,
                  items: {
                    type: 'object',
                    required: ['content', 'contentType'],
                    properties: {
                      ctypeAlternativeId: {
                        type: 'string',
                        description: 'Id for <b><samp>multipart/alternative</samp></b>',
                        example: '1'
                      },
                      ctypeRelatedId: {
                        type: 'string',
                        description: 'Id for <b><samp>multipart/related</samp></b>',
                        example: '1'
                      },
                      content: {
                        type: 'string',
                        description: "Base64 encoded string of the mime content.",
                        format: 'base64',
                        example: 'AaBbCc12DdEe34=='
                      },
                      contentType: {
                        type: 'string',
                        description: 'Content type for mime content.',
                        example: 'text/plain; charset=UTF-8'
                      },
                      contentDisposition: {
                        type: 'string',
                        example: 'inline'
                      },
                      contentDescription: {
                        type: 'string',
                        example: 'description'
                      },
                      contentId: {
                        description: 'This is mandatory if <b><samp>contentLanguage</samp></b> is provided.<br>This is used for the <b><samp>x-language-&lt;contentLanguage&gt;</samp></b> body header value.',
                        type: 'string',
                        example: '<cid>'
                      },
                      contentLanguage: {
                        description: 'This is mandatory if <b><samp>contentLangSubject</samp></b> is provided.<br>Format: 2-Letter ISO Language Code<br>This is used for the <b><samp>x-language-&lt;contentLanguage&gt;</samp></b> and <b><samp>x-lang-subject-&lt;contentLanguage&gt;</samp></b> body header keys.',
                        type: 'string',
                        example: 'en'
                      },
                      contentLangSubject: {
                        description: 'This is used for the <b><samp>x-lang-subject-&lt;contentLanguage&gt;</samp></b> body header value.',
                        type: 'string',
                        example: 'localized subject'
                      }
                    }
                  }
                },
                attachment: {
                  type: 'array',
                  description: 'An array of attachment definitions for specific message.',
                  items: {
                    type: 'object',
                    required: ['content', 'contentType', 'contentDescription', 'contentTransferEncoding', 'contentDisposition'],
                    properties: {
                      content: {
                        type: 'string',
                        format: 'base64',
                        example: 'AaBbCc12DdEe34=='
                      },
                      ctypeRelatedId: {
                        type: 'string',
                        example: '1'
                      },
                      contentId: {
                        type: 'string',
                        example: '<cid>'
                      },
                      contentType: {
                        type: 'string',
                        example: 'image/png'
                      },
                      contentDescription: {
                        type: 'string',
                        example: 'description'
                      },
                      contentTransferEncoding: {
                        type: 'string',
                        example: 'base64'
                      },
                      contentDisposition: {
                        type: 'string',
                        example: 'inline; filename=file_name.png'
                      }
                    }
                  }
                }
              }
            }
          },
          attachments: {
            type: 'array',
            description: 'An array of attachment definitions for all messages.',
            items: {
              type: 'object',
              required: ['content', 'contentType', 'contentDescription', 'contentTransferEncoding', 'contentDisposition'],
              properties: {
                content: {
                  type: 'string',
                  format: 'base64',
                  example: 'AaBbCc12DdEe34=='
                },
                ctypeRelatedId: {
                  type: 'string',
                  example: '1'
                },
                contentId: {
                  type: 'string',
                  example: '<cid>'
                },
                contentType: {
                  type: 'string',
                  example: 'application/pdf'
                },
                contentDescription: {
                  type: 'string',
                  example: 'description'
                },
                contentTransferEncoding: {
                  type: 'string',
                  example: 'base64'
                },
                contentDisposition: {
                  type: 'string',
                  example: 'attachment; filename=file_name.pdf'
                }
              }
            }
          }
        }
      },
      MessageSuccessResult: {
        type: 'object',
        required: ['status', 'results'],
        properties: {
          status: {
            type: 'string',
            example: 'success'
          },
          results: {
            type: 'object',
            required: ['response', 'batchId', 'messageId'],
            properties: {
              response: {
                type: 'string',
                example: 'Message queued as uuid'
              },
              batchId: {
                type: 'string',
                example: 'uuid@domain.com'
              },
              messageId: {
                type: 'string',
                example: 'uuid@domain.com'
              }
            }
          }
        }
      },
      MessageErrorResult: {
        type: 'object',
        required: ['code', 'status', 'message'],
        properties: {
          code: {
            type: 'integer',
            format: 'int32',
            example: 400
          },
          status: {
            type: 'string',
            example: 'error'
          },
          message: {
            type: 'string',
            example: 'error message'
          },
          details: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                example: 'error message'
              },
              path: {
                type: 'array',
                items: {
                  type: 'any'
                },
                example: ['object', 0, 'field']
              },
              type: {
                type: 'string',
                example: 'pattern name'
              },
              context: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    example: 'format name'
                  },
                  valids: {
                    type: 'array',
                    items: {
                      type: 'any'
                    },
                    example: ['value1', 'value2', 'value3']
                  },
                  label: {
                    type: 'string',
                    example: 'object[0].field'
                  },
                  value: {
                    type: 'any',
                    example: 'value'
                  },
                  key: {
                    type: 'any',
                    example: 'field'
                  }
                }
              }
            }
          }
        }
      }
    },
    securitySchemes: {
      BasicAuth: {
        type: 'http',
        scheme: 'basic'
      }
    },
    requestBodies: {}
  },
  security: [
    {
      BasicAuth: []
    }
  ]
}

const options = {
  swaggerDefinition,
  apis: [] // Path to the API routes in your Node.js application
}

const swaggerSpec = swaggerJSDoc(options)
module.exports = swaggerSpec
