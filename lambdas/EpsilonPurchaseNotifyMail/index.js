/**
* @type {import('@types/aws-lambda').APIGatewayProxyHandler}
*/
const AWS = require("aws-sdk");
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require("ioredis");
const lambda = new AWS.Lambda();

process.env.TZ = "Asia/Tokyo";

/**
* GachaUsreSMS.
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

	// Database info
	const readDbConfig = {
		host: process.env.DBREADENDPOINT,
		user: process.env.DBUSER,
		password: process.env.DBPASSWORD,
		database: process.env.DBDATABSE,
		charset: process.env.DBCHARSET
	};

	const ENVID = process.env.ENVID;

	const redisConfig = [
		{ host: process.env.REDISPOINT1, port: 6379 },
		{ host: process.env.REDISPOINT2, port: 6379 },
	];
	const cluster = new redis.Cluster(redisConfig, {
		dnsLookup: (address, callback) => callback(null, address),
		redisOptions: { tls: true },
	});

	let mysql_con;
	let response = {};

	try {
		const { paymentHistoryId } = event || {};
		console.log('incoming paymentHistoryId >>>>', paymentHistoryId);

		// mysql connect
		mysql_con = await mysql.createConnection(readDbConfig);

		const paymentHistorySql = `
		SELECT 
			userId, 
			userEmail,
			userPaymentHistoryPaymentPointId,
			userPaymentHistoryPaymentFinishedAt
		FROM UserPaymentHistory 
		JOIN User ON userPaymentHistoryUserId = userId 
		WHERE userPaymentHistoryId = ?`;

		const [paymentHistoryData] = await mysql_con.query(paymentHistorySql, [paymentHistoryId]);

		const { userId, userEmail, userPaymentHistoryPaymentPointId, userPaymentHistoryPaymentFinishedAt } = paymentHistoryData[0] || {};


		//Get todays sale list
		const todaysSalesListSql = `
		SELECT 
			userPaymentHistoryId, 
			userPaymentHistoryPaymentFinishedAt, 
			userPaymentHistoryPaymentPointId, 
			pointHistoryPaymentValue,
			userPaymentHistoryUserId 
		FROM UserPaymentHistory 
		JOIN PointHistory ON userPaymentHistoryId = pointHistoryUserPaymentHistoryId
		WHERE userPaymentHistoryStatus = 1 AND userPaymentHistoryPaymentPattern = 3 AND userPaymentHistoryCreatedAt BETWEEN UNIX_TIMESTAMP(CURDATE()) AND UNIX_TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY))
		ORDER BY userPaymentHistoryPaymentFinishedAt DESC`;

		const [todaysSalesListData] = await mysql_con.query(todaysSalesListSql, []);

		let todaysSaleListStr = '';
		let todaysTotalSaleValue = 0;

		for (const row of todaysSalesListData) {
			const { userPaymentHistoryPaymentFinishedAt, userPaymentHistoryUserId, pointHistoryPaymentValue } = row || {};

			todaysSaleListStr += `${formatDate(userPaymentHistoryPaymentFinishedAt)}\t¥${new Intl.NumberFormat('ja-JP').format(pointHistoryPaymentValue)}\tID:${userPaymentHistoryUserId}\n`;
			todaysTotalSaleValue += pointHistoryPaymentValue;
		}

		console.log('todaysSalesListData >>>', todaysSalesListData)
		console.log('todaysSaleListStr >>>', todaysSaleListStr)

		const redisPointData = await cluster.lrange("point:" + ENVID + ":list", 0, -1);

		const convertedObject = redisPointData.reduce((acc, item) => {
			const parsedItem = JSON.parse(item);
			acc[parsedItem.pointId] = parsedItem;
			return acc;
		}, {});

		const { pointPrice } = convertedObject[userPaymentHistoryPaymentPointId] || {};

		let mailTo = await cluster.get("system:" + ENVID + ":smecsm");
		const emailTemplateFrom = await cluster.get("system:" + ENVID + ":msm");
		let mailSubjectFromRedis = await cluster.get("system:" + ENVID + ":smecst");//mailTitle
		let mailBodyFromRedis = await cluster.get("system:" + ENVID + ":smecsb");//mailBody

		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%amount%}", new Intl.NumberFormat('ja-JP').format(pointPrice));
		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%paymentFinishAt%}", formatDate(userPaymentHistoryPaymentFinishedAt));
		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%userMailAddress%}", userEmail);
		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%userId%}", userId);
		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%todaysTotalSaleAmount%}", new Intl.NumberFormat('ja-JP').format(todaysTotalSaleValue));
		mailBodyFromRedis = mailBodyFromRedis.replaceAll("{%todaysSaleList%}", todaysSaleListStr);

		console.log('mailTo', mailTo)
		console.log("emailTemplateFrom", emailTemplateFrom);
		console.log("mailSubjectFromRedis", mailSubjectFromRedis);
		console.log("mailBodyFromRedis", mailBodyFromRedis);

		mailTo = mailTo.split(",").map(item => item.trim());
		console.log('mailTo Array', mailTo)

		await sendMail(mailTo, mailSubjectFromRedis, mailBodyFromRedis, emailTemplateFrom);

		return getResponse({ message: "success" }, 200);

	} catch (error) {
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

	function formatDate(timestamp) {
		const date = new Date(timestamp * 1000); // Convert seconds to milliseconds
		// Adjust the time zone offset to Japan Standard Time (UTC+9)
		date.setUTCHours(date.getUTCHours() + 9);

		const formattedDate = `${date.getUTCFullYear().toString()}/${('0' + (date.getUTCMonth() + 1)).slice(-2)}/${('0' + date.getUTCDate()).slice(-2)} ${('0' + date.getUTCHours()).slice(-2)}:${('0' + date.getUTCMinutes()).slice(-2)}`;

		return formattedDate;
	}

	async function sendMail(to, subject, body, source) {
		let emailParams = {
			Destination: {
				ToAddresses: to,
			},
			Message: {
				Subject: { Data: subject },
				Body: {
					Text: { Data: body },
				}
			},
			Source: source
		};

		let payload = JSON.stringify(emailParams);
		console.log(payload);
		let invokeParams = {
			FunctionName: "sendMail-" + process.env.ENV,
			InvocationType: "Event",
			Payload: payload
		};
		// invoke lambda
		let result = await lambda.invoke(invokeParams).promise();
		// console.log("==========result", result)
		if (result.$response.error) throw (500, result.$response.error.message);

		return result;
	}
};
