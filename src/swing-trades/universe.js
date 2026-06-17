const NASDAQ_100 = [
  'AAPL', 'ABNB', 'ADBE', 'ADI', 'ADP', 'ADSK', 'AEP', 'AMAT', 'AMD', 'AMGN',
  'AMZN', 'ANSS', 'APP', 'ARM', 'ASML', 'AVGO', 'AXON', 'AZN', 'BIIB', 'BKNG',
  'BKR', 'CCEP', 'CDNS', 'CDW', 'CEG', 'CHTR', 'CMCSA', 'COST', 'CPRT', 'CRWD',
  'CSCO', 'CSGP', 'CSX', 'CTAS', 'CTSH', 'DASH', 'DDOG', 'DXCM', 'EA', 'EXC',
  'FANG', 'FAST', 'FTNT', 'GEHC', 'GFS', 'GILD', 'GOOG', 'GOOGL', 'HON', 'IDXX',
  'INTC', 'INTU', 'ISRG', 'KDP', 'KHC', 'KLAC', 'LIN', 'LRCX', 'LULU', 'MAR',
  'MCHP', 'MDB', 'MDLZ', 'MELI', 'META', 'MNST', 'MRVL', 'MSFT', 'MSTR', 'MU',
  'NFLX', 'NVDA', 'NXPI', 'ODFL', 'ON', 'ORLY', 'PANW', 'PAYX', 'PCAR', 'PDD',
  'PEP', 'PLTR', 'PYPL', 'QCOM', 'REGN', 'ROP', 'ROST', 'SBUX', 'SNPS', 'TEAM',
  'TMUS', 'TSLA', 'TTD', 'TTWO', 'TXN', 'VRSK', 'VRTX', 'WBD', 'WDAY', 'XEL',
  'ZS',
];

// Curated S&P 500 liquid-major seed. Keep this explicit so scans are stable and
// do not depend on scraping an index constituent page at runtime.
const SP_500_MAJOR_SEED = [
  'MMM', 'A', 'AAL', 'AAPL', 'ABBV', 'ABT', 'ACN', 'ADBE', 'ADI', 'ADM',
  'ADP', 'ADSK', 'AEP', 'AES', 'AFL', 'AIG', 'AIZ', 'AJG', 'AKAM', 'ALB',
  'ALL', 'AMAT', 'AMD', 'AME', 'AMGN', 'AMP', 'AMT', 'AMZN', 'ANET', 'ANSS',
  'AON', 'AOS', 'APA', 'APD', 'APH', 'APO', 'ARE', 'ATO', 'AVGO', 'AVY',
  'AXON', 'AXP', 'AZO', 'BA', 'BAC', 'BALL', 'BAX', 'BBY', 'BDX', 'BEN',
  'BIIB', 'BK', 'BKNG', 'BLK', 'BMY', 'BR', 'BRO', 'BSX', 'BWA', 'BX',
  'C', 'CAG', 'CAH', 'CAT', 'CB', 'CBOE', 'CBRE', 'CCI', 'CCL', 'CDNS',
  'CE', 'CEG', 'CF', 'CHD', 'CHRW', 'CHTR', 'CI', 'CINF', 'CL', 'CLX',
  'CMCSA', 'CME', 'CMG', 'CMI', 'CMS', 'CNC', 'CNP', 'COF', 'COO', 'COP',
  'COR', 'COST', 'CPB', 'CPRT', 'CRM', 'CRWD', 'CSCO', 'CSX', 'CTAS', 'CTRA',
  'CTSH', 'CVS', 'CVX', 'D', 'DAL', 'DD', 'DE', 'DELL', 'DFS', 'DG',
  'DGX', 'DHI', 'DHR', 'DIS', 'DLR', 'DLTR', 'DOW', 'DPZ', 'DRI', 'DTE',
  'DUK', 'DVA', 'DVN', 'DXCM', 'EA', 'EBAY', 'ECL', 'ED', 'EFX', 'EG',
  'EIX', 'EL', 'ELV', 'EMN', 'EMR', 'ENPH', 'EOG', 'EPAM', 'EQIX', 'EQR',
  'EQT', 'ES', 'ESS', 'ETN', 'ETR', 'EW', 'EXC', 'EXPE', 'EXR', 'F',
  'FANG', 'FAST', 'FCX', 'FICO', 'FIS', 'FITB', 'FI', 'FMC', 'FOX', 'FOXA',
  'FSLR', 'FTNT', 'GD', 'GE', 'GEHC', 'GEN', 'GILD', 'GIS', 'GM', 'GNRC',
  'GOOG', 'GOOGL', 'GPC', 'GPN', 'GS', 'GWW', 'HAL', 'HAS', 'HBAN', 'HD',
  'HES', 'HIG', 'HOLX', 'HON', 'HPE', 'HPQ', 'HRL', 'HSIC', 'HST', 'HSY',
  'HUM', 'IBM', 'ICE', 'IDXX', 'IEX', 'ILMN', 'INCY', 'INTC', 'INTU', 'INVH',
  'IP', 'IPG', 'IQV', 'IR', 'IRM', 'ISRG', 'IT', 'ITW', 'J', 'JBHT',
  'JBL', 'JCI', 'JKHY', 'JNJ', 'JPM', 'K', 'KDP', 'KEY', 'KEYS', 'KHC',
  'KIM', 'KLAC', 'KMB', 'KMI', 'KO', 'KR', 'L', 'LDOS', 'LEN', 'LH',
  'LHX', 'LIN', 'LKQ', 'LLY', 'LMT', 'LOW', 'LRCX', 'LULU', 'LUV', 'LVS',
  'LW', 'LYB', 'LYV', 'MA', 'MAR', 'MAS', 'MCD', 'MCHP', 'MCK', 'MCO',
  'MDLZ', 'MDT', 'META', 'MET', 'MGM', 'MHK', 'MKC', 'MKTX', 'MLM', 'MMC',
  'MMM', 'MNST', 'MO', 'MOS', 'MPC', 'MPWR', 'MRK', 'MRNA', 'MS', 'MSCI',
  'MSFT', 'MSI', 'MTB', 'MTCH', 'MU', 'NDAQ', 'NEE', 'NFLX', 'NI', 'NKE',
  'NOC', 'NOW', 'NRG', 'NSC', 'NTAP', 'NTRS', 'NUE', 'NVDA', 'NVR', 'NXPI',
  'O', 'ODFL', 'OKE', 'OMC', 'ON', 'ORCL', 'ORLY', 'OTIS', 'OXY', 'PANW',
  'PARA', 'PAYC', 'PAYX', 'PCAR', 'PCG', 'PEG', 'PEP', 'PFE', 'PFG', 'PG',
  'PGR', 'PH', 'PHM', 'PKG', 'PLD', 'PLTR', 'PM', 'PNC', 'PNR', 'PODD',
  'PPG', 'PPL', 'PRU', 'PSA', 'PSX', 'PTC', 'PWR', 'PYPL', 'QCOM', 'RCL',
  'REG', 'REGN', 'RF', 'RJF', 'RL', 'RMD', 'ROK', 'ROL', 'ROP', 'ROST',
  'RSG', 'RTX', 'SBUX', 'SCHW', 'SHW', 'SJM', 'SLB', 'SMCI', 'SNA', 'SNPS',
  'SO', 'SPG', 'SPGI', 'SRE', 'STE', 'STLD', 'STT', 'STX', 'STZ', 'SWK',
  'SYF', 'SYK', 'SYY', 'T', 'TAP', 'TDG', 'TEL', 'TER', 'TFC', 'TGT',
  'TJX', 'TMO', 'TMUS', 'TPL', 'TRGP', 'TRMB', 'TROW', 'TRV', 'TSCO', 'TSLA',
  'TSN', 'TT', 'TTWO', 'TXN', 'TXT', 'TYL', 'UAL', 'UBER', 'UDR', 'UHS',
  'ULTA', 'UNH', 'UNP', 'UPS', 'URI', 'USB', 'V', 'VLO', 'VLTO', 'VMC',
  'VRSK', 'VST', 'VTR', 'VZ', 'WAB', 'WAT', 'WBA', 'WBD', 'WDC', 'WELL',
  'WFC', 'WM', 'WMB', 'WMT', 'WRB', 'WST', 'WTW', 'WY', 'WYNN', 'XEL',
  'XOM', 'XYL', 'YUM', 'ZBH', 'ZBRA', 'ZTS',
];

export function buildMajorUsUniverse(extraSymbols = []) {
  return [...new Set([...SP_500_MAJOR_SEED, ...NASDAQ_100, ...extraSymbols]
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter(Boolean))]
    .sort();
}

export const DEFAULT_MAJOR_US_UNIVERSE = buildMajorUsUniverse();
