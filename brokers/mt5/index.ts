import { THandler, TBroker, TStarter, TMessage, EType, EAction, ETypeContract, TDocumentOrder } from '../../types';
import { TDocument } from './types';
import { db } from '../../mongodb';
import { Logger, ELogLevel } from '../../logger';
import config from '../../config.json';
import MetaApi, { MetatraderAccount, MetatraderTradeResponse, PendingTradeOptions, StreamingMetaApiConnection } from 'metaapi.cloud-sdk';
import { exit } from 'process';

const logger = new Logger(ELogLevel.ALL, config.log.hasConsoleOutput, config.log.frequency, config.log.isEnable);

const TOTAL_CASH = process.env.TOTAL_CASH;

const token = process.env.MT5_TOKEN as string;
const login = process.env.MT5_LOGIN as string;

if (!token || !login) {
  console.error('ENV DOES NOT CONTAIN MT5_TOKEN, MT5_LOGIN');
  exit(0);
}

const api = new MetaApi(token, {
  retryOpts: {
    minDelayInSeconds: 0.3,
    maxDelayInSeconds: 1,
    retries: 50,
  }
});

let account: MetatraderAccount;
let connection: StreamingMetaApiConnection;

const starter: TStarter = async () => {
  account = await api.metatraderAccountApi.getAccounts({}).then(_ => _.find(a => a.login === login && a.type.startsWith('cloud'))) as MetatraderAccount;
  console.log('Deploying account');
  await account.deploy();
  console.log('Waiting for API server to connect to broker (may take couple of minutes)');
  await account.waitConnected();

  // connect to MetaApi API
  //@ts-ignore
  connection = account.getStreamingConnection();
  await connection.connect();

  // wait until terminal state synchronized to the local state
  console.log('Waiting for SDK to synchronize to terminal state (may take some time depending on your history size)');
  //@ts-ignore
  await connection.waitSynchronized();
  console.log('MT5 READY');
}

const handler: THandler = async (message: TMessage) => {
  const timeStart = performance.now();
  const orderId = message.orderId;
  const collection = db.collection(message.channelId + '_MT5');
  const ticker = message.ticker.split('.').join('');
  const TOTAL_QUANTITY = 0.01;
  switch (message.type) {
    case EType.OPEN: {
      const options: PendingTradeOptions = {
        comment: `${message.price} : ${orderId}`,
      };

      const order = message.contractType === ETypeContract.MARKET
      ? await connection[message.action === EAction.BUY ? 'createMarketBuyOrder' : 'createMarketSellOrder'](ticker, TOTAL_QUANTITY, message.stopLoss, message.takeProfit, options)
      : await connection[message.action === EAction.BUY ? 'createLimitBuyOrder' : 'createLimitSellOrder'](ticker, TOTAL_QUANTITY, message.price, message.stopLoss, message.takeProfit, options)

      logger.add(orderId, 'OPEN', order);

      await collection.insertOne({
        orderMessageId: orderId,
        order,
      } as TDocument);
      break;
    }
    case EType.MODIFICATION: {
      let document: TDocument;
      try {
        document = await collection.findOne({ orderMessageId: orderId }) as TDocument;
      } catch (error) {
        logger.error(orderId, `DOES NOT EXIST ${orderId}`, error);
        break;
      }
      if (!document!.order?.positionId) {
        logger.error(orderId, 'TRY MODIFICATE WITHOUT OPEN');
      }
      let order: MetatraderTradeResponse | null = null;
      try {
        order = await connection.modifyPosition(document!.order.positionId, message.stopLoss, message.takeProfit); // modificate
      } catch(error) {
        console.error(error);
        logger.add(orderId, 'MODIFICATE PENDING ORDER', { document });
        order = await connection.modifyOrder(document.order.orderId, message.price, message.stopLoss, message.takeProfit);
      }
      logger.add(orderId, 'MODIFICATE', { document, order });
      await collection.findOneAndUpdate({ orderMessageId: orderId }, { order }); // update info about order in mongo
      break;
    }
    case EType.CLOSE: {
      let document: TDocument;
      try {
        document = await collection.findOne({ orderMessageId: orderId }) as TDocument;
      } catch (error) {
        logger.error(orderId, `DOES NOT EXIST ${orderId}`, error);
        break;
      }
      if (!document?.order?.positionId) {
        logger.error(orderId, 'TRY CLOSE WITHOUT OPEN');
      }
      let order: MetatraderTradeResponse | null = null;
      try {
        order = await connection.closePosition(document.order.positionId, {});
      } catch(error) {
        console.error(error);
        logger.add(orderId, 'CLOSE PENDING ORDER', { document });
        order = await connection.cancelOrder(document.order.orderId);
      }
      logger.add(orderId, 'CLOSE', { document, order });
      break;
    }
  }

  const timeFinish = performance.now();
  
  logger.add(orderId, 'HANDLE EXECUTION', (timeFinish - timeStart).toFixed(2));
};

export default {
  starter,
  handler,
} as TBroker;
