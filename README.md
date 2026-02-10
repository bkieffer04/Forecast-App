# ERCOT HB_WEST 15-Minute Forecast App

**Live Demo:**  
https://forecast-app-eta-one.vercel.app/

This application presents a 15-minute interval electricity price forecast for the ERCOT settlement point **HB_WEST**, along with contextual historical comparisons and performance metrics. It is designed as a lightweight, interpretable forecasting and visualization tool suitable for operational decision-making.

---

## Key Features

### 1. 15-Minute Forecast (96 intervals per day)

- Displays a full day of 15-minute forecasted settlement point prices.
- Forecast updates dynamically when selecting any date within the next 7 days.
- Clean visualization with clear separation between forecasted and historical data.

### 2. Same-Weekday Historical Actuals

- For any selected forecast date, the app overlays **actual prices from the same weekday one week prior**.
- Example: Selecting a Friday forecast shows actuals from the previous Friday.
- Provides an intuitive, apples-to-apples comparison for intraday price behavior.

### 3. Backtest Metrics

- Includes a backtest comparing the seasonal baseline forecast to historical actuals.
- Metrics displayed:
  - **MAE (Mean Absolute Error)**
  - **MAPE (Mean Absolute Percentage Error)**
- Backtest context is clearly labeled to avoid misinterpretation.

### 4. Daily Summary Statistics

For both forecasted prices and historical actuals, the app computes:

- Minimum
- Maximum
- Average
- Standard deviation

Metrics are presented in a compact, readable format with explanatory tooltips to ensure accessibility for non-technical users.

### 5. Interactive Date Selection

- Replaces a traditional date picker with a **7-day “bubble” selector**.
- Prevents invalid date selection.
- Improves usability on both desktop and smaller screens.

### 6. Performance and Stability

- Server-side caching reduces redundant ERCOT API calls.
- API requests are bounded in time range and payload size to prevent timeouts.
- Graceful error handling and request timeouts ensure the UI remains responsive.

### 7. Production-Ready Deployment

- Deployed on Vercel with automatic deployments from the `main` branch.
- Secrets are stored securely using environment variables.
- No ERCOT credentials are exposed to the client.

---

## Forecast Methodology

The forecast is generated using a **seasonal baseline model**.

For each 15-minute interval:

- The forecast value is computed as the **average price for the same day-of-week and interval over the prior four weeks**.
- This approach captures weekly seasonality while remaining fast, transparent, and easy to interpret.

This model was intentionally selected to:

- Serve as a strong, explainable baseline
- Be stable with limited data
- Act as a benchmark for more advanced approaches

---

## Assumptions and Design Decisions

- A standard day consists of **96 intervals** under normal conditions.
- Forecasts are purely historical and do not incorporate exogenous inputs (e.g., weather, load, outages).
- Historical actuals are aligned by interval index, which is sufficient for baseline comparison.
- The application prioritizes clarity, correctness, and interpretability over model complexity.

---

## Known Limitations

- Daylight Saving Time transition days may contain fewer or more than 96 intervals.
- Extreme price spikes are not explicitly modeled and may be smoothed by averaging.
- The seasonal baseline does not adapt to sudden regime changes or structural market shifts.

---

## Potential Enhancements

- Incorporate weather, load, or outage data as explanatory variables.
- Add quantile bands (e.g., P10 / P50 / P90) to convey forecast uncertainty.
- Implement rolling retraining windows and interval-level error diagnostics.
- Persist historical forecasts to enable long-term performance tracking.

---

## Summary

This project demonstrates:

- Practical ingestion of ERCOT public data APIs
- Thoughtful forecasting model selection and validation
- Clear, user-focused data visualization
- Production-grade deployment and caching strategies
- Explicit communication of assumptions and limitations

The result is a clean, usable forecasting tool that balances technical rigor with real-world usability.
