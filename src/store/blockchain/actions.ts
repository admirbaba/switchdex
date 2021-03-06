// tslint:disable:max-file-line-count
import { ERC20TokenContract, ERC721TokenContract } from '@0x/contract-wrappers';
import { signatureUtils } from '@0x/order-utils';
import { MetamaskSubprovider } from '@0x/subproviders';
import { BigNumber } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import { createAction, createAsyncAction } from 'typesafe-actions';

import { addCollection, findCollectibleCollectionsBySlug, getCollectibleCollections } from '../../common/collections';
import {
    FEE_PERCENTAGE,
    FEE_RECIPIENT,
    NETWORK_ID,
    START_BLOCK_LIMIT,
    UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
    USE_RELAYER_MARKET_UPDATES,
    ZERO,
} from '../../common/constants';
import { addWethAvailableMarket } from '../../common/markets';
import { ConvertBalanceMustNotBeEqualException } from '../../exceptions/convert_balance_must_not_be_equal_exception';
import { SignedOrderException } from '../../exceptions/signed_order_exception';
import { getConfiguredSource } from '../../services/collectibles_metadata_sources';
import { subscribeToAllFillEvents, subscribeToFillEvents } from '../../services/exchange';
import { getGasEstimationInfoAsync } from '../../services/gas_price_estimation';
import { LocalStorage } from '../../services/local_storage';
import { getTokenMetaData } from '../../services/relayer';
import { tokensToTokenBalances, tokenToTokenBalance } from '../../services/tokens';
import { deleteWeb3Wrapper } from '../../services/web3_wrapper';
import * as serviceWorker from '../../serviceWorker';
import { envUtil } from '../../util/env';
import { buildFill } from '../../util/fills';
import { getKnownTokens, getTokenMetadaDataFromContract, isWeth } from '../../util/known_tokens';
import { getKnownTokensIEO } from '../../util/known_tokens_ieo';
import { getLogger } from '../../util/logger';
import { buildOrderFilledNotification } from '../../util/notifications';
import { buildSellCollectibleOrder } from '../../util/orders';
import { providerFactory } from '../../util/provider_factory';
import { getTransactionOptions } from '../../util/transactions';
import {
    BlockchainState,
    Collectible,
    GasInfo,
    MarketFill,
    MARKETPLACES,
    NotificationKind,
    OrderSide,
    ProviderType,
    ServerState,
    ThunkCreator,
    Token,
    TokenBalance,
    TokenBalanceIEO,
    TokenIEO,
    Wallet,
    Web3State,
} from '../../util/types';
import { goToHome } from '../actions';
import { getAllCollectibles, setCollectibleCollection } from '../collectibles/actions';
import {
    fetchMarkets,
    setCurrencyPair,
    setMarketTokens,
    updateMarketPriceEther,
    updateMarketPriceQuote,
    updateMarketPriceTokens,
} from '../market/actions';
import {
    fetchAllIEOOrders,
    fetchPastFills,
    fetchUserIEOOrders,
    getOrderBook,
    getOrderbookAndUserOrders,
    initializeRelayerData,
    setFeePercentage,
    setFeeRecipient,
    subscribeToRelayerWebsocketFillEvents,
} from '../relayer/actions';
import {
    getCollectibleCollectionSelected,
    getCurrencyPair,
    getCurrentMarketPlace,
    getEthAccount,
    getGasPriceInWei,
    getMarkets,
    getTokenBalances,
    getWallet,
    getWethBalance,
    getWethTokenBalance,
} from '../selectors';
import {
    addFills,
    addMarketFills,
    addNotifications,
    setFills,
    setHasUnreadNotifications,
    setMarketFills,
    setNotifications,
    setNotKnownToken,
    setUserFills,
    setUserMarketFills,
} from '../ui/actions';

const logger = getLogger('Blockchain::Actions');

export const convertBalanceStateAsync = createAsyncAction(
    'blockchain/CONVERT_BALANCE_STATE_fetch_request',
    'blockchain/CONVERT_BALANCE_STATE_fetch_success',
    'blockchain/CONVERT_BALANCE_STATE_fetch_failure',
)<void, void, void>();

export const initializeBlockchainData = createAction('blockchain/init', resolve => {
    return (blockchainData: Partial<BlockchainState>) => resolve(blockchainData);
});

export const setEthAccount = createAction('blockchain/ETH_ACCOUNT_set', resolve => {
    return (ethAccount: string) => resolve(ethAccount);
});

export const setWeb3State = createAction('blockchain/WEB3_STATE_set', resolve => {
    return (web3State: Web3State) => resolve(web3State);
});

export const setTokenBalances = createAction('blockchain/TOKEN_BALANCES_set', resolve => {
    return (tokenBalances: TokenBalance[]) => resolve(tokenBalances);
});

export const setTokenBalance = createAction('blockchain/TOKEN_BALANCE_set', resolve => {
    return (tokenBalances: TokenBalance) => resolve(tokenBalances);
});
export const setBaseTokenIEO = createAction('blockchain/BASE_TOKEN_IEO_set', resolve => {
    return (token: TokenIEO) => resolve(token);
});

export const setBaseTokenBalanceIEO = createAction('blockchain/BASE_TOKEN_BALANCE_IEO_set', resolve => {
    return (token: TokenBalanceIEO) => resolve(token);
});

export const setTokenBalancesIEO = createAction('blockchain/TOKEN_BALANCES_IEO_set', resolve => {
    return (tokenBalances: TokenBalanceIEO[]) => resolve(tokenBalances);
});

export const setEthBalance = createAction('blockchain/ETH_BALANCE_set', resolve => {
    return (ethBalance: BigNumber) => resolve(ethBalance);
});

export const setWethBalance = createAction('blockchain/WETH_BALANCE_set', resolve => {
    return (wethBalance: BigNumber) => resolve(wethBalance);
});

export const setWethTokenBalance = createAction('blockchain/WETH_TOKEN_BALANCE_set', resolve => {
    return (wethTokenBalance: TokenBalance | null) => resolve(wethTokenBalance);
});

export const setGasInfo = createAction('blockchain/GAS_INFO_set', resolve => {
    return (gasInfo: GasInfo) => resolve(gasInfo);
});
export const setWallet = createAction('blockchain/Wallet_set', resolve => {
    return (wallet: Wallet) => resolve(wallet);
});

export const resetWallet = createAction('blockchain/Wallet_reset', resolve => {
    return () => resolve();
});

export const toggleTokenLock: ThunkCreator<Promise<any>> = (
    token: Token,
    isUnlocked: boolean,
    address?: string,
    isProxy: boolean = true,
) => {
    return async (dispatch, getState, { getContractWrappers, getWeb3Wrapper }) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const gasPrice = getGasPriceInWei(state);
        const contractWrappers = await getContractWrappers();
        const web3Wrapper = await getWeb3Wrapper();
        const approveAddress = address ? address : contractWrappers.contractAddresses.erc20Proxy;

        const erc20Token = new ERC20TokenContract(token.address, contractWrappers.getProvider());
        const amount = isUnlocked ? ZERO : UNLIMITED_ALLOWANCE_IN_BASE_UNITS;
        const tx = await erc20Token.approve(approveAddress, amount).sendTransactionAsync({
            from: ethAccount,
            ...getTransactionOptions(gasPrice),
        });

        web3Wrapper.awaitTransactionSuccessAsync(tx).then(() => {
            // tslint:disable-next-line:no-floating-promises
            dispatch(updateTokenBalancesOnToggleTokenLock(token, isUnlocked));
        });

        return tx;
    };
};

export const transferToken: ThunkCreator<Promise<any>> = (
    token: Token,
    amount: BigNumber,
    address: string,
    isEth: boolean,
) => {
    return async (dispatch, getState, { getContractWrappers, getWeb3Wrapper }) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const gasPrice = getGasPriceInWei(state);

        const contractWrappers = await getContractWrappers();
        const web3Wrapper = await getWeb3Wrapper();
        let txHash;
        if (isEth) {
            txHash = await web3Wrapper.sendTransactionAsync({
                from: ethAccount.toLowerCase(),
                to: address.toLowerCase(),
                value: amount,
                gasPrice: getTransactionOptions(gasPrice).gasPrice,
            });
        } else {
            const erc20Token = new ERC20TokenContract(token.address, contractWrappers.getProvider());
            txHash = await erc20Token.transfer(address.toLowerCase(), amount).sendTransactionAsync({
                from: ethAccount,
                ...getTransactionOptions(gasPrice),
            });
        }

        const tx = web3Wrapper.awaitTransactionSuccessAsync(txHash);

        dispatch(
            addNotifications([
                {
                    id: txHash,
                    kind: NotificationKind.TokenTransferred,
                    amount,
                    token,
                    address,
                    tx,
                    timestamp: new Date(),
                },
            ]),
        );

        /*web3Wrapper.awaitTransactionSuccessAsync(tx).then(() => {
            // tslint:disable-next-line:no-floating-promises
            dispatch(updateTokenBalancesOnToggleTokenLock(token, isUnlocked));
        });*/

        return txHash;
    };
};

export const updateTokenBalancesOnToggleTokenLock: ThunkCreator = (token: Token, isUnlocked: boolean) => {
    return async (dispatch, getState) => {
        const state = getState();

        if (isWeth(token.symbol)) {
            const wethTokenBalance = getWethTokenBalance(state) as TokenBalance;
            dispatch(
                setWethTokenBalance({
                    ...wethTokenBalance,
                    isUnlocked: !isUnlocked,
                }),
            );
        } else {
            const tokenBalances = getTokenBalances(state);
            const updatedTokenBalances = tokenBalances.map(tokenBalance => {
                if (tokenBalance.token.address !== token.address) {
                    return tokenBalance;
                }

                return {
                    ...tokenBalance,
                    isUnlocked: !isUnlocked,
                };
            });

            dispatch(setTokenBalances(updatedTokenBalances));
        }
    };
};

export const updateWethBalance: ThunkCreator<Promise<any>> = (newWethBalance: BigNumber) => {
    return async (dispatch, getState, { getContractWrappers }) => {
        const contractWrappers = await getContractWrappers();
        const state = getState();
        const ethAccount = getEthAccount(state);
        const gasPrice = getGasPriceInWei(state);
        const wethBalance = getWethBalance(state);

        let txHash: string;
        const wethToken = contractWrappers.weth9;
        if (wethBalance.isLessThan(newWethBalance)) {
            txHash = await wethToken.deposit().sendTransactionAsync({
                value: newWethBalance.minus(wethBalance),
                from: ethAccount,
                ...getTransactionOptions(gasPrice),
            });
        } else if (wethBalance.isGreaterThan(newWethBalance)) {
            txHash = await wethToken.withdraw(wethBalance.minus(newWethBalance)).sendTransactionAsync({
                from: ethAccount,
                ...getTransactionOptions(gasPrice),
            });
        } else {
            throw new ConvertBalanceMustNotBeEqualException(wethBalance, newWethBalance);
        }

        return txHash;
    };
};

export const updateTokenBalances: ThunkCreator<Promise<any>> = (txHash?: string) => {
    return async (dispatch, getState, { getWeb3Wrapper }) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const knownTokens = getKnownTokens();
        const wethToken = knownTokens.getWethToken();
        const allTokenBalances = await tokensToTokenBalances([...knownTokens.getTokens(), wethToken], ethAccount);
        const wethBalance = allTokenBalances.find(b => b.token.symbol === wethToken.symbol);
        const tokenBalances = allTokenBalances.filter(b => b.token.symbol !== wethToken.symbol);
        dispatch(setTokenBalances(tokenBalances));

        const web3Wrapper = await getWeb3Wrapper();
        const ethBalance = await web3Wrapper.getBalanceInWeiAsync(ethAccount);
        if (wethBalance) {
            dispatch(setWethBalance(wethBalance.balance));
        }
        dispatch(setEthBalance(ethBalance));
        return ethBalance;
    };
};

export const updateTokenBalance: ThunkCreator<Promise<any>> = (token: Token) => {
    return async (dispatch, getState, { getWeb3Wrapper }) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const knownTokens = getKnownTokens();
        const wethToken = knownTokens.getWethToken();
        const tokenBalance = await tokensToTokenBalances([token], ethAccount);
        const wethBalance = tokenBalance.find(b => b.token.symbol === wethToken.symbol);
        if (wethBalance) {
            dispatch(setWethBalance(wethBalance.balance));
        } else {
            dispatch(setTokenBalance(tokenBalance[0]));
        }

        const web3Wrapper = await getWeb3Wrapper();
        const ethBalance = await web3Wrapper.getBalanceInWeiAsync(ethAccount);

        dispatch(setEthBalance(ethBalance));
        return ethBalance;
    };
};

export const updateGasInfo: ThunkCreator = () => {
    return async dispatch => {
        const fetchedGasInfo = await getGasEstimationInfoAsync();
        dispatch(setGasInfo(fetchedGasInfo));
    };
};

let fillEventsSubscription: string | null = null;
export const setConnectedUserNotifications: ThunkCreator<Promise<any>> = (ethAccount: string) => {
    return async (dispatch, getState, { getContractWrappers, getWeb3Wrapper }) => {
        const knownTokens = getKnownTokens();
        const localStorage = new LocalStorage(window.localStorage);

        dispatch(setEthAccount(ethAccount));

        dispatch(setNotifications(localStorage.getNotifications(ethAccount)));
        dispatch(setHasUnreadNotifications(localStorage.getHasUnreadNotifications(ethAccount)));

        const state = getState();
        const web3Wrapper = await getWeb3Wrapper();
        const contractWrappers = await getContractWrappers();

        const blockNumber = await web3Wrapper.getBlockNumberAsync();

        const lastBlockChecked = localStorage.getLastBlockChecked(ethAccount);

        const fromBlock =
            lastBlockChecked !== null ? lastBlockChecked + 1 : Math.max(blockNumber - START_BLOCK_LIMIT, 1);

        const toBlock = blockNumber;

        const markets = getMarkets(state);

        const subscription = subscribeToFillEvents({
            exchange: contractWrappers.exchange,
            fromBlock,
            toBlock,
            ethAccount,
            fillEventCallback: async fillEvent => {
                if (!knownTokens.isValidFillEvent(fillEvent)) {
                    return;
                }

                const timestamp = await web3Wrapper.getBlockTimestampAsync(fillEvent.blockNumber || blockNumber);
                const notification = buildOrderFilledNotification(fillEvent, knownTokens, markets);
                dispatch(
                    addNotifications([
                        {
                            ...notification,
                            timestamp: new Date(timestamp * 1000),
                        },
                    ]),
                );
            },
            pastFillEventsCallback: async fillEvents => {
                const validFillEvents = fillEvents.filter(knownTokens.isValidFillEvent);

                const notifications = await Promise.all(
                    validFillEvents.map(async fillEvent => {
                        const timestamp = await web3Wrapper.getBlockTimestampAsync(
                            fillEvent.blockNumber || blockNumber,
                        );
                        const notification = buildOrderFilledNotification(fillEvent, knownTokens, markets);

                        return {
                            ...notification,
                            timestamp: new Date(timestamp * 1000),
                        };
                    }),
                );

                dispatch(addNotifications(notifications));
            },
        });

        if (fillEventsSubscription) {
            contractWrappers.exchange.unsubscribe(fillEventsSubscription);
        }
        fillEventsSubscription = subscription;

        localStorage.saveLastBlockChecked(blockNumber, ethAccount);
    };
};

let fillEventsDexSubscription: string | null = null;
export const setConnectedDexFills: ThunkCreator<Promise<any>> = (ethAccount: string, userAccount: string) => {
    return async (dispatch, getState, { getContractWrappers, getWeb3Wrapper }) => {
        const knownTokens = getKnownTokens();
        const localStorage = new LocalStorage(window.localStorage);
        const storageFills = localStorage.getFills(ethAccount).filter(f => {
            return knownTokens.isKnownAddress(f.tokenBase.address) && knownTokens.isKnownAddress(f.tokenQuote.address);
        });
        dispatch(setFills(storageFills));
        dispatch(setUserFills(localStorage.getFills(userAccount)));
        dispatch(setMarketFills(localStorage.getMarketFills(ethAccount)));
        dispatch(setUserMarketFills(localStorage.getMarketFills(userAccount)));

        const state = getState();
        const web3Wrapper = await getWeb3Wrapper();
        const contractWrappers = await getContractWrappers();

        const blockNumber = await web3Wrapper.getBlockNumberAsync();

        const lastBlockChecked = localStorage.getLastBlockChecked(ethAccount);
        let limitBlocksToFetch = START_BLOCK_LIMIT;
        if (lastBlockChecked) {
            limitBlocksToFetch = blockNumber - lastBlockChecked;
            if (limitBlocksToFetch > START_BLOCK_LIMIT) {
                limitBlocksToFetch = START_BLOCK_LIMIT;
            }
        }
        /*const fromBlock =
            lastBlockChecked !== null ? lastBlockChecked + 1 : Math.max(blockNumber - START_BLOCK_LIMIT, 1);*/
        const fromBlock = Math.max(blockNumber - limitBlocksToFetch, 1);
        // lastBlockChecked !r== null ? lastBlockChecked + 1 : Math.max(blockNumbe - START_BLOCK_LIMIT, 1);

        const toBlock = blockNumber;

        const markets = getMarkets(state);

        const subscription = subscribeToAllFillEvents({
            exchange: contractWrappers.exchange,
            fromBlock,
            toBlock,
            ethAccount,
            fillEventCallback: async fillEvent => {
                if (!knownTokens.isValidFillEvent(fillEvent)) {
                    return;
                }
                const timestamp = await web3Wrapper.getBlockTimestampAsync(fillEvent.blockNumber || blockNumber);
                const fill = buildFill(fillEvent, knownTokens, markets);
                dispatch(
                    addFills([
                        {
                            ...fill,
                            timestamp: new Date(timestamp * 1000),
                        },
                    ]),
                );
                dispatch(
                    addMarketFills({
                        [fill.market]: [
                            {
                                ...fill,
                                timestamp: new Date(timestamp * 1000),
                            },
                        ],
                    }),
                );
            },
            pastFillEventsCallback: async fillEvents => {
                const validFillEvents = fillEvents.filter(knownTokens.isValidFillEvent);
                const fills = await Promise.all(
                    validFillEvents.map(async fillEvent => {
                        const timestamp = await web3Wrapper.getBlockTimestampAsync(
                            fillEvent.blockNumber || blockNumber,
                        );
                        const fill = buildFill(fillEvent, knownTokens, markets);

                        return {
                            ...fill,
                            timestamp: new Date(timestamp * 1000),
                        };
                    }),
                );
                dispatch(addFills(fills));
                const marketsFill: MarketFill = {};
                fills.forEach(f => {
                    if (marketsFill[f.market]) {
                        marketsFill[f.market].push(f);
                    } else {
                        marketsFill[f.market] = [f];
                    }
                });
                dispatch(addMarketFills(marketsFill));
            },
        });

        if (fillEventsDexSubscription) {
            contractWrappers.exchange.unsubscribe(fillEventsDexSubscription);
        }
        fillEventsDexSubscription = subscription;

        localStorage.saveLastBlockChecked(blockNumber, ethAccount);
    };
};

export const chooseWallet: ThunkCreator<Promise<any>> = () => {
    return async (dispatch, getState) => {
        dispatch(setWeb3State(Web3State.Loading));
        const state = getState();
        const currentMarketPlace = getCurrentMarketPlace(state);

        try {
            await dispatch(initWalletBeginCommon());

            if (currentMarketPlace === MARKETPLACES.ERC20) {
                // tslint:disable-next-line:no-floating-promises
                dispatch(initWalletERC20());
            } else {
                // tslint:disable-next-line:no-floating-promises
                dispatch(initWalletERC721());
            }
        } catch (error) {
            // Web3Error
            logger.error('There was an error when initializing the wallet', error);
            dispatch(setWeb3State(Web3State.Error));
        }
    };
};

export const initWallet: ThunkCreator<Promise<any>> = (wallet: Wallet) => {
    return async (dispatch, getState) => {
        dispatch(setWeb3State(Web3State.Loading));
        const state = getState();
        const currentMarketPlace = getCurrentMarketPlace(state);
        try {
            await dispatch(initWalletBeginCommon(wallet));
            switch (currentMarketPlace) {
                case MARKETPLACES.ERC20:
                    // tslint:disable-next-line:no-floating-promises
                    dispatch(initWalletERC20());
                    break;
                case MARKETPLACES.ERC721:
                    // tslint:disable-next-line:no-floating-promises
                    dispatch(initWalletERC721(wallet));
                    break;
                case MARKETPLACES.Margin:
                    // tslint:disable-next-line:no-floating-promises
                    dispatch(initWalletMargin());
                    break;
                case MARKETPLACES.Defi:
                    // tslint:disable-next-line:no-floating-promises
                    dispatch(initWalletDefi());
                    break;

                default:
                    break;
            }
        } catch (error) {
            // Web3Error
            logger.error('There was an error when initializing the wallet', error);
            dispatch(setWeb3State(Web3State.Error));
        }
    };
};

const initWalletBeginCommon: ThunkCreator<Promise<any>> = (wallet: Wallet) => {
    return async (dispatch, getState, { initializeWeb3Wrapper }) => {
        const web3Wrapper = await initializeWeb3Wrapper(wallet);

        if (web3Wrapper) {
            dispatch(setWallet(wallet));
            const [ethAccount] = await web3Wrapper.getAvailableAddressesAsync();
            const knownTokens = getKnownTokens();
            const wethToken = knownTokens.getWethToken();
            const wethTokenBalance = await tokenToTokenBalance(wethToken, ethAccount);
            const ethBalance = await web3Wrapper.getBalanceInWeiAsync(ethAccount);

            // tslint:disable-next-line: await-promise
            await dispatch(
                initializeBlockchainData({
                    ethAccount,
                    web3State: Web3State.Done,
                    ethBalance,
                    wethTokenBalance,
                    tokenBalances: [],
                }),
            );

            dispatch(
                initializeRelayerData({
                    orders: [],
                    userOrders: [],
                    orderBookState: ServerState.NotLoaded,
                    marketsStatsState: ServerState.NotLoaded,
                    marketFillsState: ServerState.NotLoaded,
                }),
            );
            // tslint:disable-next-line:no-floating-promises
            dispatch(updateGasInfo());

            // tslint:disable-next-line:no-floating-promises
            dispatch(updateMarketPriceEther());

            const networkId = await web3Wrapper.getNetworkIdAsync();
            if (networkId !== NETWORK_ID) {
                dispatch(setWeb3State(Web3State.Error));
            }
        } else {
            dispatch(setWeb3State(Web3State.Connect));
        }
    };
};

const initWalletERC20: ThunkCreator<Promise<any>> = () => {
    return async (dispatch, getState, { getWeb3Wrapper }) => {
        const web3Wrapper = await getWeb3Wrapper();
        if (!web3Wrapper) {
            // tslint:disable-next-line:no-floating-promises
            dispatch(initializeAppWallet());
            //  dispatch(initializeAppNoMetamaskOrLocked());

            // tslint:disable-next-line:no-floating-promises
            dispatch(getOrderBook());
        } else {
            const parsedUrl = new URL(window.location.href.replace('#/', ''));
            const base = parsedUrl.searchParams.get('base');
            const knownTokens = getKnownTokens();
            if (base && Web3Wrapper.isAddress(base) && !knownTokens.isKnownAddress(base)) {
                const tokenToAdd = await knownTokens.addTokenByAddress(base);
                const market = tokenToAdd && addWethAvailableMarket(tokenToAdd);
                if (market) {
                    dispatch(setCurrencyPair(market));
                }
                dispatch(setNotKnownToken(true));
            }
            const state = getState();
            const ethAccount = getEthAccount(state);

            const tokenBalances = await tokensToTokenBalances(knownTokens.getTokens(), ethAccount);

            const currencyPair = getCurrencyPair(state);
            const baseToken = knownTokens.getTokenBySymbol(currencyPair.base);
            const quoteToken = knownTokens.getTokenBySymbol(currencyPair.quote);
            dispatch(setMarketTokens({ baseToken, quoteToken }));

            dispatch(setTokenBalances(tokenBalances));

            // tslint:disable-next-line:no-floating-promises
            dispatch(getOrderbookAndUserOrders());

            try {
                await dispatch(fetchMarkets());

                await dispatch(updateMarketPriceTokens());
                // For executing this method (setConnectedUserNotifications) is necessary that the setMarkets method is already dispatched, otherwise it wont work (redux-thunk problem), so it's need to be dispatched here
                // tslint:disable-next-line:no-floating-promises
                dispatch(setConnectedUserNotifications(ethAccount));
                if (!USE_RELAYER_MARKET_UPDATES) {
                    // tslint:disable-next-line:no-floating-promises
                    dispatch(setConnectedDexFills(FEE_RECIPIENT, ethAccount));
                }

                if (USE_RELAYER_MARKET_UPDATES) {
                    // tslint:disable-next-line:no-floating-promises
                    dispatch(subscribeToRelayerWebsocketFillEvents());
                    // tslint:disable-next-line:no-floating-promises
                    dispatch(fetchPastFills());
                }
            } catch (error) {
                // Relayer error
                logger.error('The fetch markets from the relayer failed', error);
            }
            // tslint:disable-next-line:no-floating-promises
            dispatch(updateMarketPriceQuote());
        }
    };
};

const initWalletMargin: ThunkCreator<Promise<any>> = () => {
    return async (dispatch, getState, { getWeb3Wrapper }) => {
        const web3Wrapper = await getWeb3Wrapper();
        if (!web3Wrapper) {
            // tslint:disable-next-line:no-floating-promises
            dispatch(initializeAppWallet());
        } else {
            const state = getState();
            const knownTokens = getKnownTokens();
            const ethAccount = getEthAccount(state);
            const tokenBalances = await tokensToTokenBalances(knownTokens.getTokens(), ethAccount);
            dispatch(setTokenBalances(tokenBalances));
            try {
                await dispatch(updateMarketPriceTokens());
            } catch (error) {
                // Relayer error
                logger.error('The fetch markets from the relayer failed', error);
            }
        }
    };
};

const initWalletDefi: ThunkCreator<Promise<any>> = () => {
    return async (dispatch, getState, { getWeb3Wrapper }) => {
        const web3Wrapper = await getWeb3Wrapper();
        if (!web3Wrapper) {
            // tslint:disable-next-line:no-floating-promises
            dispatch(initializeAppWallet());
        } else {
            const state = getState();
            const knownTokens = getKnownTokens();
            const ethAccount = getEthAccount(state);
            const tokenBalances = await tokensToTokenBalances(knownTokens.getTokens(), ethAccount);
            dispatch(setTokenBalances(tokenBalances));
            try {
                await dispatch(updateMarketPriceTokens());
            } catch (error) {
                // Relayer error
                logger.error('The fetch markets from the relayer failed', error);
            }
        }
    };
};

const initWalletERC721: ThunkCreator<Promise<any>> = (wallet: Wallet) => {
    return async (dispatch, getState, { getWeb3Wrapper }) => {
        const web3Wrapper = await getWeb3Wrapper();
        if (web3Wrapper) {
            await dispatch(initCollectionFromUrl(wallet));
            const state = getState();
            const ethAccount = getEthAccount(state);
            // tslint:disable-next-line:no-floating-promises
            dispatch(getAllCollectibles(ethAccount));
        } else {
            // tslint:disable-next-line:no-floating-promises
            dispatch(initializeAppWallet());

            // tslint:disable-next-line:no-floating-promises
            dispatch(getAllCollectibles());
        }
    };
};

const initCollectionFromUrl: ThunkCreator<Promise<any>> = (wallet?: Wallet) => {
    return async (dispatch, getState, { getWeb3Wrapper }) => {
        const parsedUrl = new URL(window.location.href.replace('#/', ''));

        const collectiblePath = parsedUrl.pathname.split('/');
        const collections = getCollectibleCollections();
        const feeRecipient = parsedUrl.searchParams.get('affilliateAddress') || FEE_RECIPIENT;
        let feePercentage = Number(parsedUrl.searchParams.get('affilliateFee')) || FEE_PERCENTAGE;
        if (feePercentage > 0.05 || feePercentage < 0) {
            feePercentage = 0.05;
        }
        dispatch(setFeePercentage(feePercentage));
        dispatch(setFeeRecipient(feeRecipient));

        if (collectiblePath.length > 2) {
            const collectionSlug = collectiblePath[2];
            if (Web3Wrapper.isAddress(collectionSlug)) {
                const collectibleSource = getConfiguredSource();
                const collectionSea = await collectibleSource.fetchCollectionAsync(collectionSlug);
                if (collectionSea) {
                    addCollection(collectionSea);
                    dispatch(setCollectibleCollection(collectionSea));
                    return;
                } else if (!wallet) {
                    const tokenMetadadata = await getTokenMetaData(collectionSlug);
                    if (tokenMetadadata) {
                        const collection = addCollection(tokenMetadadata);
                        dispatch(setCollectibleCollection(collection));
                    }
                } else {
                    const token = await getTokenMetadaDataFromContract(collectionSlug);
                    if (token) {
                        const collection = addCollection(token);
                        // tslint:disable-next-line:no-floating-promises
                        dispatch(setCollectibleCollection(collection));
                    } else {
                        // tslint:disable-next-line:no-floating-promises
                        dispatch(setCollectibleCollection(collections[0]));
                        // tslint:disable-next-line:no-floating-promises
                        dispatch(goToHome());
                    }
                }
            } else {
                const findCollection = findCollectibleCollectionsBySlug(collectionSlug);
                if (findCollection) {
                    dispatch(setCollectibleCollection(findCollection));
                } else {
                    dispatch(setCollectibleCollection(collections[0]));
                    // tslint:disable-next-line:no-floating-promises
                    dispatch(goToHome());
                }
            }
        } else {
            dispatch(setCollectibleCollection(collections[0]));
        }
    };
};

export const unlockCollectible: ThunkCreator<Promise<string>> = (collectible: Collectible) => {
    return async (dispatch, getState, { getContractWrappers }) => {
        const state = getState();
        const contractWrappers = await getContractWrappers();
        const gasPrice = getGasPriceInWei(state);
        const ethAccount = getEthAccount(state);
        const selectedCollection = getCollectibleCollectionSelected(state);
        const erc721Token = new ERC721TokenContract(selectedCollection.address, contractWrappers.getProvider());

        const tx = await erc721Token
            .setApprovalForAll(contractWrappers.contractAddresses.erc721Proxy, true)
            .sendTransactionAsync({ from: ethAccount, ...getTransactionOptions(gasPrice) });
        return tx;
    };
};

export const unlockToken: ThunkCreator = (token: Token, address?: string, isProxy?: boolean) => {
    return async dispatch => {
        return dispatch(toggleTokenLock(token, false, address, isProxy));
    };
};

export const lockToken: ThunkCreator = (token: Token) => {
    return async dispatch => {
        return dispatch(toggleTokenLock(token, true));
    };
};

export const createSignedCollectibleOrder: ThunkCreator = (
    collectible: Collectible,
    side: OrderSide,
    startPrice: BigNumber,
    expirationDate: BigNumber,
    endPrice: BigNumber | null,
) => {
    return async (dispatch, getState, { getContractWrappers, getWeb3Wrapper }) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        const collectibleId = new BigNumber(collectible.tokenId);
        try {
            const web3Wrapper = await getWeb3Wrapper();
            const contractWrappers = await getContractWrappers();
            const selectedCollection = getCollectibleCollectionSelected(state);
            const wethAddress = getKnownTokens().getWethToken().address;
            const exchangeAddress = contractWrappers.exchange.address;
            let order;
            if (endPrice) {
                throw new Error('DutchAuction currently unsupported');
                // DutchAuction sell
                // const senderAddress = contractWrappers.dutchAuction.address;
                // order = await buildDutchAuctionCollectibleOrder({
                //     account: ethAccount,
                //     amount: new BigNumber('1'),
                //     price: startPrice,
                //     endPrice,
                //     expirationDate,
                //     wethAddress,
                //     collectibleAddress: selectedCollection.address,
                //     collectibleId,
                //     exchangeAddress,
                //     senderAddress,
                // });
            } else {
                // Normal Sell
                order = await buildSellCollectibleOrder(
                    {
                        account: ethAccount,
                        amount: new BigNumber('1'),
                        price: startPrice,
                        exchangeAddress,
                        expirationDate,
                        collectibleId,
                        collectibleAddress: selectedCollection.address,
                        wethAddress,
                    },
                    side,
                );
            }

            const provider = new MetamaskSubprovider(web3Wrapper.getProvider());
            return signatureUtils.ecSignOrderAsync(provider, order, ethAccount);
        } catch (error) {
            throw new SignedOrderException(error.message);
        }
    };
};

/**
 *  Initializes the app with a default state if the user does not have metamask, with permissions rejected
 *  or if the user did not connected metamask to the dApp. Takes the info from the NETWORK_ID configured in the env vars
 */
export const initializeAppWallet: ThunkCreator = () => {
    return async (dispatch, getState) => {
        let state = getState();
        // detect if is mobile operate system
        // Note: need to disable service workers when inside dapp browsers
        if (envUtil.isMobileOperatingSystem()) {
            const providerType = envUtil.getProviderTypeFromWindow();
            switch (providerType) {
                case ProviderType.CoinbaseWallet:
                    serviceWorker.unregister();
                    await dispatch(initWallet(Wallet.Coinbase));
                    return;
                case ProviderType.EnjinWallet:
                    serviceWorker.unregister();
                    await dispatch(initWallet(Wallet.Enjin));
                    return;
                case ProviderType.Cipher:
                    serviceWorker.unregister();
                    await dispatch(initWallet(Wallet.Cipher));
                    return;
                default:
                    break;
            }
            // check if Trust wallet or other wallet is injected
            const provider = providerFactory.getInjectedProviderIfExists();
            if (provider) {
                const providerT = envUtil.getProviderType(provider);
                switch (providerT) {
                    case ProviderType.TrustWallet:
                        serviceWorker.unregister();
                        await dispatch(initWallet(Wallet.Trust));
                        return;
                    case ProviderType.MetaMask:
                        serviceWorker.unregister();
                        await dispatch(initWallet(Wallet.Metamask));
                        return;
                    default:
                        break;
                }
            }
        }
        const wallet = getWallet(state);
        if (!wallet) {
            dispatch(setWeb3State(Web3State.Connect));
        }
        const parsedUrl = new URL(window.location.href.replace('#/', ''));
        const base = parsedUrl.searchParams.get('base');
        const knownTokens = getKnownTokens();
        if (base && Web3Wrapper.isAddress(base) && !knownTokens.isKnownAddress(base)) {
            const tokenData = await getTokenMetaData(base);
            if (tokenData) {
                let tokenToAdd = {
                    address: tokenData.address,
                    decimals: Number(tokenData.decimals),
                    name: tokenData.name,
                    symbol: tokenData.symbol.toLowerCase(),
                    primaryColor: '#081e6e',
                    displayDecimals: 2,
                    listed: false,
                    isStableCoin: false,
                };
                tokenToAdd = await knownTokens.fetchTokenMetadaFromGecko(tokenToAdd);
                knownTokens.pushToken(tokenToAdd);
                const market = addWethAvailableMarket(tokenToAdd);
                if (market) {
                    dispatch(setCurrencyPair(market));
                }
                dispatch(setNotKnownToken(true));
            }
        }

        state = getState();
        const currencyPair = getCurrencyPair(state);
        const baseToken = knownTokens.getTokenBySymbol(currencyPair.base);
        const quoteToken = knownTokens.getTokenBySymbol(currencyPair.quote);

        dispatch(
            initializeRelayerData({
                orders: [],
                userOrders: [],
                orderBookState: ServerState.NotLoaded,
                marketsStatsState: ServerState.NotLoaded,
                marketFillsState: ServerState.NotLoaded,
            }),
        );

        // tslint:disable-next-line:no-floating-promises
        dispatch(setMarketTokens({ baseToken, quoteToken }));

        const currentMarketPlace = getCurrentMarketPlace(state);
        switch (currentMarketPlace) {
            case MARKETPLACES.ERC20:
                // tslint:disable-next-line:no-floating-promises
                dispatch(getOrderBook());

                // tslint:disable-next-line:no-floating-promises
                await dispatch(fetchMarkets());

                // tslint:disable-next-line:no-floating-promises
                await dispatch(updateMarketPriceTokens());
                // tslint:disable-next-line: no-floating-promises
                dispatch(updateMarketPriceQuote());
                break;
            case MARKETPLACES.ERC721:
                await dispatch(initCollectionFromUrl());
                // tslint:disable-next-line:no-floating-promises
                dispatch(getAllCollectibles());
                break;
            case MARKETPLACES.Margin:
                // tslint:disable-next-line:no-floating-promises
                await dispatch(updateMarketPriceTokens());
                break;
            case MARKETPLACES.Defi:
                // tslint:disable-next-line:no-floating-promises
                await dispatch(updateMarketPriceTokens());
                break;

            default:
                break;
        }
        // tslint:disable-next-line:no-floating-promises
        dispatch(updateMarketPriceEther());
        if (USE_RELAYER_MARKET_UPDATES) {
            // tslint:disable-next-line:no-floating-promises
            dispatch(subscribeToRelayerWebsocketFillEvents());
            // tslint:disable-next-line:no-floating-promises
            dispatch(fetchPastFills());
        }
    };
};

// delete all wallets instance
export const logoutWallet: ThunkCreator = () => {
    return async (dispatch, getState, { getWeb3Wrapper }) => {
        dispatch(setWeb3State(Web3State.Connect));
        const state = getState();
        const wallet = getWallet(state);
        dispatch(resetWallet());
        if (wallet === Wallet.WalletConnect) {
            const web3Wrapper = getWeb3Wrapper();
            const provider = (await web3Wrapper).getProvider();
            // @ts-ignore
            await provider.close();
        }

        deleteWeb3Wrapper();

        const { location } = window;
        location.reload();
        // needs to reload when the wallet is Torus
        if (wallet === Wallet.Torus) {
            location.reload();
        }
    };
};

// Lock wallet
export const lockWallet: ThunkCreator = () => {
    return async (dispatch, getState) => {
        dispatch(setWeb3State(Web3State.Locked));
    };
};

export const fetchBaseTokenIEO: ThunkCreator = (token: TokenIEO) => {
    return async (dispatch, getState) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        if (!ethAccount) {
            return;
        }
        const wethBalance = getWethTokenBalance(state);
        const tokenBalance = (await tokenToTokenBalance(token, ethAccount)) as TokenBalanceIEO;
        dispatch(setBaseTokenBalanceIEO(tokenBalance));
        dispatch(setBaseTokenIEO(token));
        try {
            // tslint:disable-next-line: no-floating-promises
            dispatch(fetchUserIEOOrders(ethAccount, token, (wethBalance && wethBalance.token) || null));
        } catch (error) {
            logger.error('The fetch ieo orders from the relayer failed', error);
        }
    };
};

export const fetchLaunchpad: ThunkCreator = () => {
    return async (dispatch, getState) => {
        const state = getState();
        const ethAccount = getEthAccount(state);
        if (ethAccount) {
            const knownTokens = getKnownTokensIEO();
            const tokenBalances = (await tokensToTokenBalances(
                knownTokens.getTokens(),
                ethAccount,
            )) as TokenBalanceIEO[];
            dispatch(setTokenBalancesIEO(tokenBalances));
        }
        try {
            // tslint:disable-next-line: no-floating-promises
            dispatch(fetchAllIEOOrders());
        } catch (error) {
            logger.error('The fetch ieo orders from the relayer failed', error);
        }
    };
};
