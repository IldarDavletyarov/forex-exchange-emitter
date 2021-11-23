import { Contract, OrderType, Order, OrderAction, IBApiNext, SecType } from '@stoqey/ib';
import { TMessage, EAction, ETypeContract, EOrderType, TDocumentOrder } from '../types';
import { Logger } from '../logger';
import { Collection } from 'mongodb';

const TOTAL_QUANTITY = 20000;

const preOrder: Order = {
  totalQuantity: TOTAL_QUANTITY,
  transmit: true,
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const getContract = (message: TMessage) => { 
  const split = message.ticker.split('.');
  const isCurrencyPair = split[0] !== 'XAU'; // @todo to channel listener

  return isCurrencyPair 
  ? {
    secType: SecType.CASH,
    currency: split[1],
    symbol: split[0],
    exchange: 'IDEALPRO',
  }
  : {
    secType: SecType.CMDTY,
    currency: split[1],
    symbol: split.join(''),
    exchange: 'SMART',
  } as Contract;
};

export const getOrderType = (contractType: ETypeContract) => contractType === ETypeContract.LIMIT ? OrderType.LMT : OrderType.MKT;

export const getWrappedAction = (action: EAction) => action === EAction.BUY ? OrderAction.SELL : OrderAction.BUY;

export const getAction = (action: EAction) => action === EAction.BUY ? OrderAction.BUY : OrderAction.SELL;

export const getTakeProfitOrder = (message: TMessage): Order => ({
  ... preOrder,
  orderType: OrderType.LMT,
  action: getWrappedAction(message.action),
  lmtPrice: message.takeProfit,
});

export const getStopLossOrder = (message: TMessage): Order => ({
  ... preOrder,
  orderType: OrderType.STP,
  action: getWrappedAction(message.action),
  auxPrice: message.stopLoss,
});

export const getOpenOrder = (message: TMessage): Order => ({
  ... preOrder,
  orderType: getOrderType(message.contractType),
  action: getAction(message.action),
  lmtPrice: message.contractType === ETypeContract.LIMIT ? message.price : undefined,
})

export const modificatePendingOrder = async (orderType: EOrderType, message: TMessage, logger: Logger, ib: IBApiNext, contract: Contract, collection: Collection) => {
  const modificatedOrderId = (await collection.findOneAndDelete({ orderType, orderIdMessage: message.orderId })).value?.orderId as number;

  logger.add(message.orderId, `MODIFICATED ${orderType} ID`, modificatedOrderId);

  if (modificatedOrderId) {
    ib.cancelOrder(modificatedOrderId);
    logger.add(message.orderId, 'DELETE', modificatedOrderId);
    const order = (orderType === EOrderType.TAKEPROFIT ? getTakeProfitOrder : getStopLossOrder)(message);

    const orderId = await ib.placeNewOrder(contract, order);
    await collection.insertOne(getDocument(orderId, orderType, message));
  } else {
    logger.error(message.orderId, `TRY MODIFY ${orderType} WITHOUT PREVIOUS`);
  }
}

export const openPendingOrder = async (orderType: EOrderType, message: TMessage, logger: Logger, ib: IBApiNext, contract: Contract): Promise<TDocumentOrder> => {
  logger.add(message.orderId, `${orderType} OPEN`);
    
  const order = (orderType === EOrderType.TAKEPROFIT ? getTakeProfitOrder : getStopLossOrder)(message);

  const orderId = await ib.placeNewOrder(contract, order);

  return getDocument(orderId, orderType, message);
}

export const getCloseOrder = (message: TMessage): Order => ({
  ... preOrder,
  orderType: OrderType.MKT,
  action: getWrappedAction(message.action),
})

export const getDocument = (orderId: number, orderType: EOrderType, message: TMessage): TDocumentOrder => ({
  orderId,
  orderType,
  orderIdMessage: message.orderId,
  date: Date.now(),
  message,
});
