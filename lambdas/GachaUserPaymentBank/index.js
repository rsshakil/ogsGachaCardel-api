/**
* @type {import('@types/aws-lambda').APIGatewayProxyHandler}
*/
const AWS = require("aws-sdk");
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require("ioredis");
const lambda = new AWS.Lambda();

process.env.TZ = "Asia/Tokyo";

const jwt = require("jsonwebtoken");
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

// Purchase Pattern:
// 1 = Stripe credits
// 2 = Stripe bank transfer
// 3 = Epsilon credits
// 4 = Epsilon bank transfer
// 5 = EpsilonPayPay
// 6 = PayPay Direct
// 7 = Direct bank transfer

/**
* ManagerAppRead.
*
* @param {*} event
* @returns {json} response
*/
exports.handler = async (event) => {
	console.log("Event data:", event);
	// Reading encrypted environment variables --- required
	if (process.env.DBINFO == null) {
		const ssmreq = {
			Name: "PS_" + process.env.ENV,
			WithDecryption: true,
		};
		const ssmparam = await ssm.getParameter(ssmreq).promise();
		const dbinfo = JSON.parse(ssmparam.Parameter.Value);
		process.env.DBWRITEENDPOINT = dbinfo.DBWRITEENDPOINT;
		process.env.DBREADENDPOINT = dbinfo.DBREADENDPOINT;
		process.env.DBUSER = dbinfo.DBUSER;
		process.env.DBPASSWORD = dbinfo.DBPASSWORD;
		process.env.DBDATABSE = dbinfo.DBDATABSE;
		process.env.DBPORT = dbinfo.DBPORT;
		process.env.DBCHARSET = dbinfo.DBCHARSET;
		process.env.DBINFO = true;
		process.env.REDISPOINT1 = dbinfo.REDISPOINT1;
		process.env.REDISPOINT2 = dbinfo.REDISPOINT2;
		process.env.ENVID = dbinfo.ENVID;
		process.env.ACCESS_TOKEN_SECRET = dbinfo.ACCESS_TOKEN_SECRET;
	}
	const ENVID = process.env.ENVID;
	// Database info
	const writeDbConfig = {
		host: process.env.DBWRITEENDPOINT,
		user: process.env.DBUSER,
		password: process.env.DBPASSWORD,
		database: process.env.DBDATABSE,
		charset: process.env.DBCHARSET,
	};
	const redisConfig = [
		{ host: process.env.REDISPOINT1, port: 6379 },
		{ host: process.env.REDISPOINT2, port: 6379 },
	];
	const cluster = new redis.Cluster(redisConfig, {
		dnsLookup: (address, callback) => callback(null, address),
		redisOptions: { tls: true },
	});

	let {
		cpp,
		userPaymentHistoryPaymentPoint = 0,
		userPaymentHistoryPayerName,
		userPaymentHistoryPayerTelNo,
		userPaymentHistoryPayerMail,
		browserUUID, 
		browserUserAgent, 
		appRendersDateTime
	} = JSON.parse(event.body);

	let mysql_con;
	let response = {};

	const nowUnixTimestamp = Math.floor(new Date().getTime() / 1000);

	try {
		// jwtからユーザーIDを取得
		const result = await getUserId();
		const { success, userId, statusCode } = result || {};
		if (!success) return getResponse({ message: "Unauthorize access" }, statusCode);

		// mysql connect
		mysql_con = await mysql.createConnection(writeDbConfig);

		// 購入商品の取得
		const redisPointData = await cluster.lrange("point:" + process.env.ENVID + ":list", 0, -1);
		const convertedObject = redisPointData.reduce((acc, item) => {
			const parsedItem = JSON.parse(item);
			acc[parsedItem.pointId] = parsedItem;
			return acc;
		}, {});

		const pointId = cpp;
		const { pointValue: amount = 0 } = convertedObject[pointId] || {};

		const userInfoQuery = `SELECT userId, userEmail, userAFCode, userInvitationCode FROM User WHERE userId = ? LIMIT 0, 1`;
		const [resultUserInfo] = await mysql_con.query(userInfoQuery, userId);

		if (resultUserInfo.length == 0) getResponse({ message: "User not found!" }, 404);

		const { userEmail, userAFCode, userInvitationCode } = resultUserInfo[0] || {};

		const insert_payment_history_sql = `
        INSERT INTO UserPaymentHistory(
            userPaymentHistoryUserId, 
            userPaymentHistoryCreatedAt, 
			userPaymentHistoryPaymentPointId,
            userPaymentHistoryPaymentPoint, 
            userPaymentHistoryAFCode, 
            userPaymentHistoryInvitationCode,
            userPaymentHistoryStatus,
            userPaymentHistoryPaymentPattern,
			userPaymentHistoryPayerName,
			userPaymentHistoryPayerTelNo,
			userPaymentHistoryPayerMail,
			userPaymentHistoryIPAddress1,
			userPaymentHistoryBrowserUUID,
            userPaymentHistoryBrowserUserAgent,
            userPaymentHIstoryUserAppRendersAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
		const sourceIP = (event.requestContext.identity.sourceIp) ? event.requestContext.identity.sourceIp : '';
		const param = [
			userId,
			nowUnixTimestamp,
			pointId,
			amount,
			userAFCode,
			userInvitationCode,
			2,
			7,  //7 = bank transfer(manual)
			userPaymentHistoryPayerName,
			userPaymentHistoryPayerTelNo,
			userPaymentHistoryPayerMail,
			sourceIP,
			browserUUID,
			browserUserAgent,
			appRendersDateTime
		];

		await mysql_con.execute(insert_payment_history_sql, param);

		//Send Email
		const emailTemplateFrom = await cluster.get("system:" + ENVID + ":msm");
		const mailSubjectFromRedis = await cluster.get("system:" + ENVID + ":mbtt");//mailTitle
		let mailBodyFromRedis = await cluster.get("system:" + ENVID + ":mbmtb");//mailBody

		let siteNameJa = await cluster.get("system:" + ENVID + ":snj");
		let siteNameEn = await cluster.get("system:" + ENVID + ":sne");

		const productNameJa = siteNameJa + "" + amount + "ポイント"
		const productNameEn = siteNameEn + " " + amount + " points"

		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%PRODUCT_NAME_JA%}", productNameJa);
		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%PRODUCT_NAME_EN%}", productNameEn);
		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%PRODUCT_PRICE%}", new Intl.NumberFormat('ja-JP').format(amount));
		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%TRANSFER_PERSON_NAME%}", userPaymentHistoryPayerName);

		let emailParams = {
			Destination: {
				ToAddresses: [userEmail],
			},
			Message: {
				Subject: { Data: mailSubjectFromRedis },
				Body: {
					Text: { Data: mailBodyFromRedis },
				}
			},
			Source: emailTemplateFrom
		};

		let payload = JSON.stringify(emailParams);
		console.log(payload);
		let invokeParams = {
			FunctionName: "sendMail-" + process.env.ENV,
			InvocationType: "Event",
			Payload: payload
		};
		// invoke lambda
		let result2 = await lambda.invoke(invokeParams).promise();
		// console.log("==========result", result)
		if (result2.$response.error) throw (500, result2.$response.error.message);

		return getResponse({ message: "Payment info received successfully" }, 200);
	} catch (error) {
		if (mysql_con) await mysql_con.rollback();
		console.error("error:", error);
		response = {
			errorCode: Number(error.message),
		};
		return getResponse(response, 400);
	} finally {
		if (mysql_con) await mysql_con.close();

		try {
			cluster.disconnect();
		}
		catch (e) {
			console.log("finally error", e);
		}
	}

	function getResponse(data, statusCode = 200) {
		return {
			statusCode,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "*",
			},
			body: JSON.stringify(data),
		};
	}

	async function getUserId() {
		// ログインしている必要あり
		if (
			event.headers.Authorization &&
			event.headers.Authorization != null &&
			event.headers.Authorization != "Bearer null"
		) {
			// トークン
			const token = jwtPattern.exec(event.headers.Authorization)[1];
			console.log("token", token);
			const decoded = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
			if (decoded == null) {
				console.error("JWTが解析できない");
				return { success: false, statusCode: 103 };
			}
			console.log("decoded", decoded);
			let userId = decoded.userId;

			return { success: true, userId, statusCode: 200 };
		}
		// ログインしていない
		console.error("ログインしていない");
		return { success: false, statusCode: 101 };
	}
};
