﻿//Dependencies inclusion
const
    
    bodyParser = require('body-parser'),
    config = require('config'),
    crypto = require('crypto'),
    express = require('express'),
    https = require('https'),
    request = require('request'),
    xml2js = require('xml2js');

//Configuration Boilerplate.
var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

var moreInfoPayloadPrefix = "MORE_INFO_";
var urgentTag = "[Urgent]";
var commonTag = "[Common]";

const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ?
    process.env.MESSENGER_APP_SECRET :
    config.get('appSecret');

const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
    (process.env.MESSENGER_VALIDATION_TOKEN) :
    config.get('validationToken');

const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
    (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
    config.get('pageAccessToken');

const SERVER_URL = (process.env.SERVER_URL) ?
    (process.env.SERVER_URL) :
    config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
    console.error("Missing config values");
    process.exit(1);
}


/*
**
**In order to setup webhooks for our messenger bot, 
**A small verification is done by messenger platform
**to verify ownership and make sure webhook URLs are secure. 
**
**/

app.get('/webhook', function (req, res) {
    if (req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === VALIDATION_TOKEN) {
        console.log("Validating webhook");
        res.status(200).send(req.query['hub.challenge']);
    } else {
        console.error("Failed validation. Make sure the validation tokens match.");
        res.sendStatus(403);
    }
});


/*
**All callbacks for Messenger are POST-ed. They will be sent to the same
**webhook. Be sure to subscribe your app to your page to receive callbacks
**for your page. 
**https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
**/

app.post('/webhook', function (req, res) {
    var data = req.body;

    // Make sure this is a page subscription
    if (data.object == 'page') {

        // Iterate over each entry
        // There may be multiple if batched
        
        data.entry.forEach(function (pageEntry) {
            var pageID = pageEntry.id;
            var timeOfEvent = pageEntry.time;

            // Messaging Events.

            pageEntry.messaging.forEach(function (messagingEvent) {
                if (messagingEvent.optin) {
                    receivedAuthentication(messagingEvent);
                } else if (messagingEvent.message) {
                    receivedMessage(messagingEvent);
                } else if (messagingEvent.delivery) {
                    receivedDeliveryConfirmation(messagingEvent);
                } else if (messagingEvent.postback) {
                    receivedPostback(messagingEvent);
                } else if (messagingEvent.read) {
                    receivedMessageRead(messagingEvent);
                } else if (messagingEvent.account_linking) {
                    receivedAccountLink(messagingEvent);
                } else {
                    console.log("Webhook received unknown messagingEvent: ", messagingEvent);
                }
            });
        });

        // You must send back a 200, within 20 seconds, to ensure that we've 
        // successfully received the callback. Otherwise, the request will time out.
        res.sendStatus(200);
    }
});

/*
**
** This path is used for account linking. The account linking call-to-action
** (sendAccountLinking) is pointed to this URL. 
** 
*/
app.get('/authorize', function (req, res) {
    var accountLinkingToken = req.query['account_linking_token'];
    var redirectURI = req.query['redirect_uri'];

    var authCode = <Your Auth Code.>;

    var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

    res.render('authorize', {
        accountLinkingToken: accountLinkingToken,
        redirectURI: redirectURI,
        redirectURISuccess: redirectURISuccess
    });
});


/*
**
**Verify that the callback came from Facebook. Using the App Secret from 
**the App Dashboard, we can verify the signature that is sent with each 
**callback in the x-hub-signature field, located in the header.
**
** https://developers.facebook.com/docs/graph-api/webhooks#setup
**
*/
function verifyRequestSignature(req, res, buf) {
    var signature = req.headers["x-hub-signature"];

    if (!signature) {
        console.error("Couldn't validate the signature.");
    } else {
        var elements = signature.split('=');
        var method = elements[0];
        var signatureHash = elements[1];

        var expectedHash = crypto.createHmac('sha1', APP_SECRET)
            .update(buf)
            .digest('hex');

        if (signatureHash != expectedHash) {
            throw new Error("Couldn't validate the request signature.");
        }
    }
}

/*
** 
** The value for 'optin.ref' is defined in the entry point. For the "Send to 
** Messenger" plugin, it is the 'data-ref' field. Read more at 
** https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
**
*/

function receivedAuthentication(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfAuth = event.timestamp;

    // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
    // The developer can set this to an arbitrary value to associate the 
    // authentication callback with the 'Send to Messenger' click event. This is
    // a way to do account linking when the user clicks the 'Send to Messenger' 
    // plugin.

    var passThroughParam = event.optin.ref;

    console.log("Received authentication for user %d and page %d with pass " +
        "through param '%s' at %d", senderID, recipientID, passThroughParam,
        timeOfAuth);

    // When an authentication is received, we'll send a message back to the sender
    // to let them know it was successful.
    sendTextMessage(senderID, "Authentication successful");
}

/*
** Message Event
**
** This event is called when a message is sent to your page. The 'message' 
** object format can vary depending on the kind of message that was received.
** Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
**
** For this example, we're going to echo any text that we get. If we get some 
** special keywords ('button', 'generic', 'receipt'), then we'll send back
** examples of those bubbles to illustrate the special message bubbles we've 
** created. If we receive a message with an attachment (image, video, audio), 
** then we'll simply confirm that we've received the attachment.
** 
**
**/
function receivedMessage(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfMessage = event.timestamp;
    var message = event.message;

    console.log(JSON.stringify(message));

    var isEcho = message.is_echo;
    var messageId = message.mid;
    var appId = message.app_id;
    var metadata = message.metadata;

    // You may get a text or attachment but not both
    var messageText = message.text;
    var messageAttachments = message.attachments;
    var quickReply = message.quick_reply;

    if (isEcho) {
        // Just logging message echoes to console
        //console.log("Received echo for message %s and app %d with metadata %s",
        //    messageId, appId, metadata);
        return;
    } else if (quickReply) {
        var quickReplyPayload = quickReply.payload;
        console.log("Quick reply for message %s with payload %s",
            messageId, quickReplyPayload);

        sendTextMessage(senderID, "Quick reply tapped");
        return;
    }
    if (messageAttachments) {
        if (messageAttachments.template_type = "button") {
            switch (messageAttachments.payload) {
                case 'FEMALE_PAYLOAD':
                    sendPregnantButtonMessage(senderID);
                    break;
                case 'MALE_PAYLOAD':
                    sendAgeButtonMessage(senderID);
                    break;
                case 'OTHER_PAYLOAD':
                    sendPregnantButtonMessage(senderID);
                    break;

                case 'YES_PAYLOAD':
                    sendAgeButtonMessage(senderID);
                    break;
                case 'NO_PAYLOAD':
                    sendAgeButtonMessage(senderID);
                    break;
                case 'BACK_PAYLOAD':
                    sendGenderButtonMessage(senderID);
                    break;

                case 'AGE_LT_18_PAYLOAD':
                    sendQueryTextMessage(senderID);
                    break;
                case 'AGE_18_50_PAYLOAD':
                    sendQueryTextMessage(senderID);
                    break;
                case 'AGE_GT_50_PAYLOAD':
                    sendQueryTextMessage(senderID);
                    break;

                default:
                    sendTextMessage(senderID, "Message with payload received");
                    console.log("Payload not recognised");
            }
        }
        else {
            sendTextMessage(senderID, "Message with attachment received");
        }
    }
    else if (messageText) {
        switch (messageText) {

            case 'read receipt':
                sendReadReceipt(senderID);
                break;

            case 'typing on':
                sendTypingOn(senderID);
                break;

            case 'typing off':
                sendTypingOff(senderID);
                break;

            case 'account linking':
                sendAccountLinking(senderID);
                break;

            case 'age':
                sendAgeQuickReplyMessage(senderID);
                break;

            case 'Female':
            case 'female':
            case 'f':
            case 'Other':
            case 'other':
            case 'NA':
            case 'na':
            case 'n/a':
                sendPregnantButtonMessage(senderID);
                break;

            case 'Yes':
            case 'No':
            case 'yes':
            case 'no':
            case 'Y':
            case 'N':
            case 'y':
            case 'n':
                sendDateOfBirthMessage(senderID);
                break;

            case 'Get Started':
            case 'get started':
                sendGenderButtonMessage(senderID);
                break;

            default:
                var DoBTimeStamp = Date.parse(messageText)

                if (isNaN(DoBTimeStamp) == false) {
                    console.log("DoB = " + DoBTimeStamp);
                    var DoBDate = new Date(DoBTimeStamp);

                    sendTextMessage(senderID, DoBDate);
                    sendQueryTextMessage(senderID);
                } else {
                    if (messageText.indexOf(',') > -1) {
                        sendPotentialDiagnoses(messageText, senderID);
                    }
                    else {
                        sendTextMessage(senderID, messageText);
                    }
                }
        }
    }
}

var jsonResponse;

function sendPotentialDiagnoses(messageText, senderID) {
    var userId = <Your UserId>;
    var password = <Your password>;
    var regionId = 1;
    var queryText = messageText;
    queryText.replace(/, +\s +,*/g, ",").trim(); //replace multiple commas or commas and spaces with a single comma
    var dateOfBirth = "7";
    var gender = "m";
    //Third Party Service that suggests a given condition depending upon the API.
    var generatedUrl = "http://symptomchecker.isabelhealthcare.com/private/emr_diagnosis.jsp?flag=sortbyRW_advanced&search_type=diagnosis&system_id=2138&region=" + regionId + "&logic=&pre_diagnoses_id=&n_return=&query[use_synonym]=1&specialties=28&web_service=true&id=" + userId + "&password=" + password + "&dob=" + dateOfBirth + "&sex=" + gender + "&querytext=" + queryText;
    var encodedURI = encodeURI(generatedUrl);

    getJSON(encodedURI, assignJSON);

    var secondCount = 0

    if (jsonResponse == null) {
        if (secondCount > 5)
            setTimeout(waitForJsonToBeRetrieved, 1000);
        return;
    }


    var xml = jsonResponse;

    var parseString = xml2js.parseString;
    var extractedData = "";
    var parser = new xml2js.Parser();
    var conditions = [];
    var diagnosesName;
    var diagnosesUrl;
    var common
    var urgent
    var relevance;
    var count = 10;

    parser.parseString(xml, function (err, result) {
        //Extract the value from the data element
        for (var i = 0; i < 10; i++) {
            if (typeof result['Diagnosis_checklist']['diagnosis'][i] === 'undefined') {
                count = i; //would be one too many, had we not set it to start at 0
                break;
            }

            diagnosesName = result['Diagnosis_checklist']['diagnosis'][i]['diagnoses_name'][0];
            diagnosesUrl = encodeURI("http://patient.info/search.asp?searchterm=" + diagnosesName + "&searchcoll=All");
            common = result['Diagnosis_checklist']['diagnosis'][i]['common_diagnoses'][0];
            urgent = result['Diagnosis_checklist']['diagnosis'][i]['red_flag'][0];
            relevance = result['Diagnosis_checklist']['diagnosis'][i]['weightage'][0];
            var newDiagnosis = {
                diagnosis: {
                    'diagnosisName': diagnosesName,
                    'diagnosesUrl': diagnosesUrl,
                    'common': common,
                    'urgent': urgent,
                    'relevance': relevance
                }
            };

            conditions.push(newDiagnosis);
        };
    });


    sendConditionsAsStructuredMessage(senderID, conditions, count);
}

function getJSON(encodedURI, callback) {
    request({
        url: encodedURI,
        json: true
    }, function (error, response, body) {

        if (!error && response.statusCode === 200) {
            callback(body);
        }
    })
}

function assignJSON(JSON) {
    jsonResponse = JSON;
}

/*
** Delivery Confirmation Event
**
** This event is sent to confirm the delivery of a message. Read more about 
** these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
**
**
**/
function receivedDeliveryConfirmation(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var delivery = event.delivery;
    var messageIDs = delivery.mids;
    var watermark = delivery.watermark;
    var sequenceNumber = delivery.seq;

    if (messageIDs) {
        messageIDs.forEach(function (messageID) {
            
        });
    }
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfPostback = event.timestamp;

    // The 'payload' param is a developer-defined field which is set in a postback 
    // button for Structured Messages. 
    var payload = event.postback.payload;

    console.log("\r\nReceived postback for user %d and page %d with payload '%s' " +
        "at %d", senderID, recipientID, payload, timeOfPostback);

    switch (payload) {
        case 'FEMALE_PAYLOAD':
            sendPregnantButtonMessage(senderID);
            break;
        case 'MALE_PAYLOAD':
            sendAgeButtonMessage(senderID);
            break;
        case 'OTHER_PAYLOAD':
            sendPregnantButtonMessage(senderID);
            break;

        case 'YES_PAYLOAD':
            sendAgeButtonMessage(senderID);
            break;
        case 'NO_PAYLOAD':
            sendAgeButtonMessage(senderID);
            break;
        case 'BACK_PAYLOAD':
            sendGenderButtonMessage(senderID);
            break;

        case 'AGE_LT_18_PAYLOAD':
            sendQueryTextMessage(senderID);
            break;
        case 'AGE_18_50_PAYLOAD':
            sendQueryTextMessage(senderID);
            break;
        case 'AGE_GT_50_PAYLOAD':
            sendQueryTextMessage(senderID);
            break;

        default:
            if (payload.substring(0, moreInfoPayloadPrefix.length) == moreInfoPayloadPrefix) {
                
                var moreInfoResponse = "";
                moreInfoResponse += "[Urgent]\r\n" +
                    "Seek medical advice immediately if you're concerned this may apply to you, as emergency medical attention is required.\r\n\r\n";
                
                moreInfoResponse += "[Common]\r\nThis diagnosis is common in your region.\r\n\r\n";
                
                moreInfoResponse += "Relevance\r\nThe degree of match between the query entered and the diagnosis database."
                
                sendTextMessage(senderID, moreInfoResponse);
            }
            else {
                sendTextMessage(senderID, "Postback called");
                break;
            }
    }

}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var watermark = event.read.watermark;
    var sequenceNumber = event.read.seq;

}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    var status = event.account_linking.status;
    var authCode = event.account_linking.authorization_code;

    console.log("Received account link event with for user %d with status %s " +
        "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "image",
                payload: {
                    url: SERVER_URL + "/assets/rift.png"
                }
            }
        }
    };

    callSendAPI(messageData);
}


function sendTextMessage(recipientId, messageText) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText,
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };

    callSendAPI(messageData);
}

function sendDateOfBirthMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "What is your date of birth?",
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };

    callSendAPI(messageData);
}


function sendQueryTextMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Please enter your symptoms, separated by a comma: e.g. 'headache, back pain, temperature'",
            metadata: "QUERY_METADATA"
        }
    };

    callSendAPI(messageData);
}


function sendPregnantButtonMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Are you pregnant?",
                    buttons: [{
                        type: "postback",
                        title: "Yes",
                        payload: "YES_PAYLOAD"
                    }, {
                            type: "postback",
                            title: "No",
                            payload: "NO_PAYLOAD"
                        }, {
                            type: "postback",
                            title: "Back",
                            payload: "BACK_PAYLOAD"
                        }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

function sendGenderButtonMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "What is your gender?",
                    buttons: [{
                        type: "postback",
                        title: "Female",
                        payload: "FEMALE_PAYLOAD"
                    }, {
                            type: "postback",
                            title: "Male",
                            payload: "MALE_PAYLOAD"
                        }, {
                            type: "postback",
                            title: "Other",
                            payload: "OTHER_PAYLOAD"
                        }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

function sendAgeButtonMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Age of patient",
                    buttons: [{
                        type: "postback",
                        title: "< 18 years old",
                        payload: "AGE_LT_18_PAYLOAD"
                    }, {
                            type: "postback",
                            title: "18 - 50 years old",
                            payload: "AGE_18_50_PAYLOAD"
                        }, {
                            type: "postback",
                            title: "> 50 years old",
                            payload: "AGE_GT_50_PAYLOAD"
                        }]
                }
            }
        }
    };

    callSendAPI(messageData);
}


function sendConditionsAsStructuredMessage(recipientId, conditions, count) {
    var diagnosisElements = [];

    for (var i = 0; i < count; i++) {
        var subtitleText = "";
        if (conditions[i].diagnosis.common == "true") {
            subtitleText += commonTag + " ";
        }
        if (conditions[i].diagnosis.urgent == "true") {
            subtitleText += urgentTag + " ";
        }
        subtitleText += "Relevance: " + conditions[i].diagnosis.relevance;

        var newElement =
            {
                title: conditions[i].diagnosis.diagnosisName,
                subtitle: subtitleText,
                //item_url: conditions[i].diagnosis.diagnosesUrl,
                //image_url: SERVER_URL + "/assets/rift.png",
                buttons: [{
                    type: "postback",
                    title: "About these results",
                    payload: "MORE_INFO_" + subtitleText,
                },
                    {
                        type: "web_url",
                        url: conditions[i].diagnosis.diagnosesUrl,
                        title: "View on Patient.info"
                    }]
            }
        diagnosisElements.push(newElement);
    }


    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {

            attachment: {
                type: "template",
                payload: {
                    template_type: "generic",
                    elements: diagnosisElements
                }
            }

        }
    };

    callSendAPI(messageData);
}



function sendAgeQuickReplyMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Age of patient (years)",
            metadata: "DEVELOPER_DEFINED_METADATA",
            quick_replies: [
                {
                    "content_type": "text",
                    "title": "0-6",
                    "payload": "AGE_1_PAYLOAD"
                },
                {
                    "content_type": "text",
                    "title": "7-18",
                    "payload": "AGE_2_PAYLOAD"
                },
                {
                    "content_type": "text",
                    "title": "19-40",
                    "payload": "AGE_3_PAYLOAD"
                },
                {
                    "content_type": "text",
                    "title": "41-60",
                    "payload": "AGE_4_PAYLOAD"
                },
                {
                    "content_type": "text",
                    "title": "61+",
                    "payload": "AGE_5_PAYLOAD"
                }
            ]
        }
    };

    callSendAPI(messageData);
}


//send reciept.
function sendReadReceipt(recipientId) {
    console.log("Sending a read receipt to mark message as seen");

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "mark_seen"
    };

    callSendAPI(messageData);
}


//Typing Indicators.
function sendTypingOn(recipientId) {
    console.log("Turning typing indicator on");

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_on"
    };

    callSendAPI(messageData);
}


function sendTypingOff(recipientId) {
    console.log("Turning typing indicator off");

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_off"
    };

    callSendAPI(messageData);
}


/*
**
**Account Linkage on call to action.
**
*/
function sendAccountLinking(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Welcome. Link your account.",
                    buttons: [{
                        type: "account_link",
                        url: SERVER_URL + "/authorize"
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
**
** Call the Send API. The message data goes in the body. If successful, we'll 
** get the message id in a response 
**
**/
function callSendAPI(messageData) {
   
    request({
        uri: 'https://graph.facebook.com/v2.6/me/messages',
        qs: { access_token: PAGE_ACCESS_TOKEN },
        method: 'POST',
        json: messageData
    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var recipientId = body.recipient_id;
            var messageId = body.message_id;
     } else {
            if (response == null)
                sendTextMessage("Sorry there seems to be a connection issue currently, please try again later");
            else {
                if (response.error != null) {
                    console.error(response.error);
                }
            }
        }
    });
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.

app.listen(app.get('port'), function () {
    console.log('Node app is running on port', app.get('port'));
});

module.exports = app;