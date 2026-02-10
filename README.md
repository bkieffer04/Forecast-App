### Forecast Method

The forecast is generated using a seasonal baseline model. For each 15-minute
interval, the forecast value is computed as the average price for the same
day-of-week and interval over the prior four weeks. This provides a fast,
interpretable baseline suitable for short-term planning.

Known limitations:

- DST transition days may have fewer or more than 96 intervals.
- Extreme price spikes are not explicitly modeled.
- Future improvements could include weather or load features.
