/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();


const PAGES_VISITED = 0;
const ITEMS_PER_PAGE = 500;
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
            Name: 'PS_' + process.env.ENV,
            WithDecryption: true
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
    }

    // Database info
    const readDbConfig = {
        host: process.env.DBREADENDPOINT,
        user: process.env.DBUSER,
        password: process.env.DBPASSWORD,
        database: process.env.DBDATABSE,
        charset: process.env.DBCHARSET
    };

    let parameter = [];
    let mysql_con;
    let response;

    try {
        // mysql connect
        mysql_con = await mysql.createConnection(readDbConfig);

        const { queryStringParameters = null, pathParameters = null } = event || {};

        //get list
        if (pathParameters === null) {
            const sql_count = `
                SELECT 
                    COUNT(Item.itemId) as total_rows
                FROM Item
                JOIN CategoryTranslate ON Item.itemCategoryId = CategoryTranslate.categoryTranslateCategoryId AND categoryTranslateJpFlag = 1
                JOIN ItemStock ON Item.itemId = ItemStock.itemStockItemId
                JOIN ItemTranslate ON Item.itemId = ItemTranslate.itemTranslateItemId AND itemTranslateJpFlag = 1
            `;

            //Subquery to get itemTags in comma(,) separated string
            const item_tags_subquery = `
                SELECT 
                    GROUP_CONCAT(tagName)
                FROM ItemTag
                JOIN Tag ON ItemTag.itemTagTagId = Tag.tagId
                WHERE ItemTag.itemTagItemId = Item.itemId
            `;

            const sql_data = `
                SELECT 
                    itemId, 
                    BIN_TO_UUID(Item.itemUUID) AS itemUUID, 
                    itemTranslateName AS itemName, 
                    itemShippingFlag, 
                    itemCreatedAt, 
                    itemUpdatedAt, 
                    itemStatus, 
                    categoryTranslateName AS categoryName, 
                    itemStockUnsetCount, 
                    itemStockGachaCount, 
                    itemStockCollectionCount, 
                    itemStockShippingRequestCount, 
                    itemStockShippedCount, 
                    (${item_tags_subquery}) AS tagName
                FROM Item
                JOIN CategoryTranslate ON Item.itemCategoryId = CategoryTranslate.categoryTranslateCategoryId AND categoryTranslateJpFlag = 1
                JOIN ItemStock ON Item.itemId = ItemStock.itemStockItemId
                JOIN ItemTranslate ON Item.itemId = ItemTranslate.itemTranslateItemId AND itemTranslateJpFlag = 1
                ORDER BY itemCreatedAt DESC
                LIMIT ?, ?
            `;

            const [query_result_count, query_fields_count] = await mysql_con.query(sql_count, parameter);

            const { pagesVisited = PAGES_VISITED, itemsPerPage = ITEMS_PER_PAGE } = queryStringParameters || {};
            const offset = Number(pagesVisited) * Number(itemsPerPage);

            parameter.push(offset);
            parameter.push(Number(itemsPerPage));

            const [query_result_data, query_fields_data] = await mysql_con.query(sql_data, parameter);

            if (query_result_data.length > 0) {
                response = {
                    count: query_result_count[0]?.total_rows,
                    records: query_result_data,
                    page: pagesVisited,
                    limit: itemsPerPage,
                }
            }
            else {
                response = {
                    message: 'no data',
                }
            }
        }
        //get detail
        else if (pathParameters !== null) {
            const { itemId = 0 } = pathParameters || {};

            //For initial data
            if (itemId == 'init') {
                const category_query = `
                    SELECT 
                        categoryTranslateCategoryId AS categoryId, 
                        categoryTranslateName AS categoryName 
                    FROM CategoryTranslate 
                    JOIN Localize ON categoryTranslateLocalizeId = Localize.localizeId AND localizeCountryId > 0
                    WHERE categoryTranslateJpFlag = ?
                    ORDER BY categoryTranslateName ASC
                `;

                const tags_query = `
                    SELECT  
                        tagId, 
                        tagName
                    FROM Tag 
                    ORDER BY tagName ASC
                `;

                const localize_query = `
                    SELECT 
                        languageId,
                        languageName,
                        localizeId,
                        localizeJpFlag
                    FROM Localize
                    JOIN Language ON localizeLanguageId = languageId
                    WHERE localizeCountryId > 0 AND languageStatus = ?
                    ORDER BY localizeJpFlag DESC, localizeId ASC
                `;

                const [query_result_category, query_fields_category] = await mysql_con.query(category_query, [1]);
                const [query_result_tag, query_fields_tag] = await mysql_con.query(tags_query, []);
                const [query_result_localize, query_fields_localize] = await mysql_con.query(localize_query, [1]);

                response = {
                    categories: query_result_category,
                    tags: query_result_tag,
                    localizes: query_result_localize,
                }
            }
            //For item details
            else {
                //Subquery to get itemTags id in array
                const item_tags_subquery = `
                    SELECT 
                        JSON_ARRAYAGG(itemTagTagId)
                    FROM ItemTag
                    WHERE ItemTag.itemTagItemId = Item.itemId
                `;

                const item_translate_subquery = `
                    SELECT 
                        JSON_ARRAYAGG(
                            JSON_OBJECT(
                                'languageId', Language.languageId,
                                'languageName', Language.languageName,
                                'itemTranslateLocalizeId', Localize.localizeId,
                                'itemTranslateJpFlag', ItemTranslate.itemTranslateJpFlag,
                                'itemTranslateName', ItemTranslate.itemTranslateName,
                                'ItemTranslateDescription1', ItemTranslate.ItemTranslateDescription1,
                                'ItemTranslateDescription2', ItemTranslate.ItemTranslateDescription2,
                                'ItemTranslateDescription3', ItemTranslate.ItemTranslateDescription3
                            )
                        )
                    FROM Localize
                    JOIN Language ON Localize.localizeLanguageId = Language.languageId
                    LEFT OUTER JOIN ItemTranslate ON ItemTranslate.itemTranslateLocalizeId = Localize.localizeId AND ItemTranslate.itemTranslateItemId = Item.itemId
                    WHERE localizeCountryId > 0
                    ORDER BY localizeJpFlag DESC, localizeId ASC
                `;

                const sql_data = `
                    SELECT 
                        itemId, 
                        BIN_TO_UUID(Item.itemUUID) AS itemUUID, 
                        itemImagePath1,
                        itemImagePath2,
                        itemImagePath3,
                        itemStatus, 
                        itemShippingFlag, 
                        itemCategoryId,
                        itemMemo,
                        itemAttribute1,
                        itemAttribute2,
                        itemAttribute3,
                        itemAttribute4,
                        itemAttribute5,
                        itemAttribute6,
                        itemAttribute7,
                        itemAttribute8,
                        (${item_tags_subquery}) AS itemTags,
                        (${item_translate_subquery}) AS itemTranslates
                    FROM Item
                    WHERE itemId = ?
                    LIMIT 0, 1
                `;

                parameter.push(Number(itemId));

                const [query_result_data, query_fields_data] = await mysql_con.query(sql_data, parameter);

                if (query_result_data.length > 0)
                    response = { records: query_result_data[0] }
                else
                    response = { message: 'no data', }
            }
        }

        console.log('my response', response)

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify(response),
        }
    } catch (error) {
        console.error("error:", error)
        return {
            statusCode: 400,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify(error),
        }
    } finally {
        if (mysql_con) await mysql_con.close();
    }
};